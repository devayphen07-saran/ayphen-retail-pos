import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { createHash, randomBytes } from 'node:crypto';
import { UnitOfWork, type DbTransaction } from '#db/db.module.js';
import { rethrowUniqueViolationAs } from '#db/rethrow-unique-violation.js';
import {
  InvitationRepository,
  type InvitationRow,
  type PendingInvitationRow,
} from './invitation.repository.js';
import { RoleRepository, type RoleRow } from '../role/role.repository.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { AuditService } from '#common/audit/audit.service.js';
import { SnapshotService } from '#auth/mobile/services/snapshot.service.js';
import { RateLimitService } from '#auth/core/rate-limit.service.js';
import { SYSTEM_ROLE_CODES } from '#common/rbac/permission-matrix.constants.js';
import type { PermissionSnapshot } from '#common/types/permission-snapshot.js';

const INVITE_TTL_DAYS = 7;

/**
 * Invitation tokens are stored hashed at rest (SHA-256), like refresh tokens —
 * only the raw token (returned to the inviter for delivery) is usable, so a DB
 * read never yields a redeemable invite. Accept/reject hash the presented token
 * before lookup.
 */
const hashInvitationToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

export interface CreateInvitationInput {
  roleId: string;
  phone?: string;
  email?: string;
}

/** Domain result of creating an invitation — the raw token, for delivery. */
export interface CreateInvitationResult {
  id:    string;
  token: string;
}

/** Domain result of accepting an invitation — the store the caller joined,
 *  plus a refreshed permission snapshot (nullable — best-effort, see
 *  `applyAccept`). */
export interface AcceptInvitationResult {
  storeId:           string;
  snapshot:          PermissionSnapshot | null;
  snapshotSignature: string | null;
}

/**
 * Staff invitations (rbac.md §4, subscription §10). Invitations assign ONLY
 * custom roles (never system roles). Accept adds account membership + the
 * role assignment atomically.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: InvitationRepository,
    private readonly roleRepo: RoleRepository,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly snapshot: SnapshotService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async create(
    storeId: string,
    actorId: string,
    input: CreateInvitationInput,
  ): Promise<CreateInvitationResult> {
    const role = await this.validateContactAndRole(storeId, input);

    const rawToken = randomBytes(24).toString('base64url');
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = new Date(
      Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const invitation = await rethrowUniqueViolationAs(
      this.uow.execute(async (tx) => {
        // Lock the store row so concurrent creates serialize against the
        // expire-then-insert sequence below.
        await this.repo.lockStore(storeId, tx);

        // Nothing else transitions a lapsed invite out of 'pending' on a
        // schedule — sweep this exact contact+role's stale rows first so they
        // can't collide with uk_invitations_pending_phone/email below, then the
        // insert's constraint is the real TOCTOU guard for a genuinely LIVE
        // duplicate (same shape as the pre-check above, just race-proof).
        await this.repo.expireStalePending(storeId, input.roleId, input.phone, input.email, tx);

        const created = await this.repo.create(
          {
            storeFk: storeId,
            roleFk: input.roleId,
            phone: input.phone,
            email: input.email,
            token: tokenHash,
            invitedBy: actorId,
            expiresAt,
          },
          tx,
        );
        await this.audit.logInTransaction({
          event: 'ROLE_ASSIGNMENT_CREATED',
          activityType: 'ROLE_ASSIGNMENT_CREATED',
          prefix: 'Invitation',
          suffix: `created for role "${role.name}"`,
          userId: actorId,
          storeFk: storeId,
          isSuccess: true,
          entityType: 'Invitation',
          entityId: created.id,
        }, tx);
        return created;
      }),
      () => new ConflictError(
        ErrorCodes.INVITATION_ALREADY_PENDING,
        'A pending invitation already exists for this contact and role',
      ),
    );

    // TODO: deliver the invite (SMS via Msg91 / email) — record + token exist now;
    // push/SMS delivery is a separate wiring step (device §27: don't depend on push).

    // Return the RAW token for delivery — the DB holds only its hash.
    return { id: invitation.id, token: rawToken };
  }

  /**
   * A phone/email is required (validation-shaped, 422 not 409), the target
   * role must be a custom, invitable role of this store (BR-RBAC-006), and no
   * live invite may already exist for this exact contact+role.
   */
  private async validateContactAndRole(
    storeId: string,
    input: CreateInvitationInput,
  ): Promise<RoleRow> {
    if (!input.phone && !input.email) {
      throw new UnprocessableError(
        ErrorCodes.INVITATION_CONTACT_REQUIRED,
        'A phone number or email is required to send an invitation',
      );
    }

    const role = await this.roleRepo.findRoleInStore(input.roleId, storeId);
    if (!role)
      throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    if (SYSTEM_ROLE_CODES.has(role.code)) {
      throw new ForbiddenError(
        ErrorCodes.ROLE_NOT_ASSIGNABLE,
        'This role cannot be assigned via invitation',
      );
    }

    if (
      await this.repo.findPendingInvite(
        storeId,
        input.roleId,
        input.phone,
        input.email,
      )
    ) {
      throw new ConflictError(
        ErrorCodes.INVITATION_ALREADY_PENDING,
        'A pending invitation already exists for this contact and role',
      );
    }

    return role;
  }

  /**
   * Accept an invitation via its raw token (out-of-band delivery: SMS/email
   * link). The token is hashed before lookup — the DB holds only the hash.
   */
  async accept(
    token: string,
    userId: string,
    ip: string,
  ): Promise<AcceptInvitationResult> {
    await this.rateLimit.checkIpLimit(ip);

    const invitation = await this.repo.findByToken(hashInvitationToken(token));
    this.assertAcceptable(invitation);
    return this.applyAccept(invitation, userId);
  }

  /**
   * Accept an invitation via its id (in-app, from GET /me/invitations). No token
   * is echoed by the client; authorization is that the invitation is addressed to
   * the caller's own contact. A contact mismatch is reported as NOT_FOUND (don't
   * confirm the existence of an invite the caller isn't addressed by).
   */
  async acceptById(
    invitationId: string,
    userId: string,
    ip: string,
  ): Promise<AcceptInvitationResult> {
    await this.rateLimit.checkIpLimit(ip);

    const invitation = await this.repo.findByIdForContact(invitationId);
    this.assertAcceptable(invitation);

    const contact = await this.repo.findContactForUser(userId);
    const addressedToCaller =
      (!!invitation.phone && invitation.phone === contact?.phone) ||
      (!!invitation.email && invitation.email === contact?.email);
    if (!addressedToCaller)
      throw new NotFoundError(
        ErrorCodes.INVITATION_NOT_FOUND,
        'Invitation not found',
      );

    return this.applyAccept(invitation, userId);
  }

  /** Shared pending/expiry gate for both accept paths. */
  private assertAcceptable(
    invitation: InvitationRow | null,
  ): asserts invitation is InvitationRow {
    if (!invitation)
      throw new NotFoundError(
        ErrorCodes.INVITATION_NOT_FOUND,
        'Invitation not found',
      );
    if (invitation.status !== 'pending') {
      throw new ConflictError(
        ErrorCodes.INVITATION_NOT_PENDING,
        'This invitation is no longer pending',
      );
    }
    if (invitation.expiresAt < new Date()) {
      throw new ForbiddenError(
        ErrorCodes.INVITATION_EXPIRED,
        'This invitation has expired',
      );
    }
  }

  /** Grant membership + role atomically, then bust caches + audit. */
  private async applyAccept(
    invitation: InvitationRow,
    userId: string,
  ): Promise<AcceptInvitationResult> {
    await this.uow.execute(async (tx) => {
      // Serialize concurrent accepts against this store. Lock BEFORE the CAS
      // — same store lock create() takes.
      await this.repo.lockStore(invitation.storeFk, tx);

      // markAccepted is the real guard against a concurrent accept()/reject()
      // race on the same invitation — the status check above reads outside this
      // transaction, so both calls can pass it before either commits.
      // Checking the CAS result *before* granting membership/role means a
      // losing call never applies its side effects at all, instead of
      // applying them and then discovering the invitation was already
      // resolved by the other path.
      const accepted = await this.repo.markAccepted(invitation.id, userId, tx);
      if (!accepted)
        throw new ConflictError(
          ErrorCodes.INVITATION_NOT_PENDING,
          'This invitation is no longer pending',
        );

      await this.grantMembershipAndRole(tx, invitation, userId);
    });
    await this.rbac.invalidateUserStoreCache(userId, invitation.storeFk);
    // Same staleness bug as store creation — the cached bootstrap snapshot
    // must be dropped too, or the newly-joined store won't show up until TTL.
    await this.snapshot.invalidate(userId);

    // Best-effort: embed the freshly-rebuilt snapshot so the client can patch
    // its session state in place instead of a full bootstrap round trip.
    // invalidate() MUST run before getOrBuild() — otherwise getOrBuild's
    // cache-first read would return the stale pre-accept snapshot. A build
    // failure here doesn't fail the accept (it already committed); the client
    // falls back to its existing bootstrap call when these come back null.
    let snapshot: PermissionSnapshot | null = null;
    let snapshotSignature: string | null = null;
    try {
      const built = await this.snapshot.getOrBuild(userId);
      snapshot = built.snapshot;
      snapshotSignature = built.signature;
    } catch {
      // fields stay null — client falls back to refetchUser().
    }

    return { storeId: invitation.storeFk, snapshot, snapshotSignature };
  }

  /** Membership + role + permission-version bump + audit — all idempotent,
   *  so a retried accept is safe. */
  private async grantMembershipAndRole(
    tx: DbTransaction,
    invitation: InvitationRow,
    userId: string,
  ): Promise<void> {
    await this.repo.ensureAccountMembership(userId, invitation.storeFk, tx);
    await this.roleRepo.insertAssignmentIfAbsent(
      {
        userFk: userId,
        roleFk: invitation.roleFk,
        storeFk: invitation.storeFk,
        assignedBy: userId,
      },
      tx,
    );
    await this.rbac.bumpPermissionsVersionForRole(
      invitation.roleFk,
      invitation.storeFk,
      tx,
    );
    await this.audit.logInTransaction({
      event: 'ROLE_ASSIGNMENT_CREATED',
      activityType: 'ROLE_ASSIGNMENT_CREATED',
      prefix: 'Invitation',
      suffix: `accepted`,
      userId,
      storeFk: invitation.storeFk,
      isSuccess: true,
      entityType: 'UserRoleMapping',
      metadata: { invitationId: invitation.id, roleId: invitation.roleFk },
    }, tx);
  }

  /** Decline an invitation as the authenticated user — same token-as-proof
   *  model as accept(), just no membership/role grant. */
  async reject(token: string, ip: string): Promise<void> {
    await this.rateLimit.checkIpLimit(ip);

    const invitation = await this.repo.findByToken(hashInvitationToken(token));
    if (!invitation)
      throw new NotFoundError(
        ErrorCodes.INVITATION_NOT_FOUND,
        'Invitation not found',
      );
    if (invitation.status !== 'pending') {
      throw new ConflictError(
        ErrorCodes.INVITATION_NOT_PENDING,
        'This invitation is no longer pending',
      );
    }
    // Same CAS as accept() — if a concurrent accept() already resolved this
    // token, don't silently overwrite its outcome with 'revoked'.
    const revoked = await this.repo.markRevoked(invitation.id);
    if (!revoked)
      throw new ConflictError(
        ErrorCodes.INVITATION_NOT_PENDING,
        'This invitation is no longer pending',
      );
  }

  /** Decline in-app by id (from GET /me/invitations) — contact-authorized, no token. */
  async rejectById(
    invitationId: string,
    userId: string,
    ip: string,
  ): Promise<void> {
    await this.rateLimit.checkIpLimit(ip);

    const invitation = await this.repo.findByIdForContact(invitationId);
    if (!invitation)
      throw new NotFoundError(
        ErrorCodes.INVITATION_NOT_FOUND,
        'Invitation not found',
      );
    if (invitation.status !== 'pending') {
      throw new ConflictError(
        ErrorCodes.INVITATION_NOT_PENDING,
        'This invitation is no longer pending',
      );
    }
    const contact = await this.repo.findContactForUser(userId);
    const addressedToCaller =
      (!!invitation.phone && invitation.phone === contact?.phone) ||
      (!!invitation.email && invitation.email === contact?.email);
    if (!addressedToCaller)
      throw new NotFoundError(
        ErrorCodes.INVITATION_NOT_FOUND,
        'Invitation not found',
      );

    const revoked = await this.repo.markRevoked(invitation.id);
    if (!revoked)
      throw new ConflictError(
        ErrorCodes.INVITATION_NOT_PENDING,
        'This invitation is no longer pending',
      );
  }

  /** Pending invitations addressed to the authenticated user's phone/email. */
  async listMyInvitations(userId: string): Promise<PendingInvitationRow[]> {
    const contact = await this.repo.findContactForUser(userId);
    if (!contact) return [];
    return this.repo.listPendingForContact(contact.phone, contact.email);
  }
}
