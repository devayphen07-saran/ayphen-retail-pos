import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { createHash, randomBytes } from 'node:crypto';
import { UnitOfWork } from '#db/db.module.js';
import {
  InvitationRepository,
  type InvitationRow,
  type PendingInvitationRow,
} from './invitation.repository.js';
import { RoleRepository } from '../role/role.repository.js';
import { EntitlementService } from '../../subscription/entitlement.service.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { AuditService } from '#auth/core/audit.service.js';
import { SnapshotService } from '#auth/mobile/services/snapshot.service.js';
import { RateLimitService } from '#auth/core/rate-limit.service.js';

const SYSTEM_ROLE_CODES = new Set(['USER', 'STORE_OWNER', 'SUPER_ADMIN']);
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
  locationIds: string[];
}

/** Domain result of accepting an invitation — the store the caller joined. */
export interface AcceptInvitationResult {
  storeId: string;
}

/**
 * Staff invitations (rbac.md §4, subscription §10). Invitations assign ONLY
 * custom roles (never system roles). Creation is gated by max_users_per_store;
 * accept adds account membership + the role assignment atomically.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: InvitationRepository,
    private readonly roleRepo: RoleRepository,
    private readonly entitlements: EntitlementService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly snapshot: SnapshotService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async create(
    storeId: string,
    accountId: string,
    actorId: string,
    input: CreateInvitationInput,
  ): Promise<{ id: string; token: string }> {
    if (!input.phone && !input.email) {
      // Validation-shaped failure (a required field is missing), not a
      // resource conflict — 422, not 409.
      throw new UnprocessableError(ErrorCodes.INVITATION_CONTACT_REQUIRED, 'A phone number or email is required to send an invitation');
    }

    // Only custom roles of this store are invitable (BR-RBAC-006).
    const role = await this.roleRepo.findRoleInStore(input.roleId, storeId);
    if (!role) throw new NotFoundError(ErrorCodes.ROLE_NOT_FOUND, 'Role not found');
    if (SYSTEM_ROLE_CODES.has(role.code)) {
      throw new ForbiddenError(ErrorCodes.ROLE_NOT_ASSIGNABLE, 'This role cannot be assigned via invitation');
    }

    if (await this.repo.findPendingInvite(storeId, input.roleId, input.phone, input.email)) {
      throw new ConflictError(ErrorCodes.INVITATION_ALREADY_PENDING, 'A pending invitation already exists for this contact and role');
    }

    // Every selected location must belong to this store (and be active) — a
    // client can't scope an invite to a location outside the store it's
    // inviting into. Dedupe first so the length comparison is exact.
    const requestedLocationIds = [...new Set(input.locationIds)];
    const validLocationIds = await this.repo.filterStoreLocationIds(storeId, requestedLocationIds);
    if (validLocationIds.length !== requestedLocationIds.length) {
      throw new UnprocessableError(ErrorCodes.UNKNOWN_LOCATION, 'One or more selected locations do not belong to this store');
    }

    // max_users_per_store gate (subscription §10). Fast pre-check outside the
    // transaction for quick feedback on the common case.
    const precheckLimit = await this.entitlements.get(accountId, 'max_users_per_store');
    const precheckActive = await this.repo.countActiveStaff(storeId);
    if (!this.entitlements.canCreate(precheckLimit, precheckActive)) {
      throw new ForbiddenError(ErrorCodes.USER_LIMIT_REACHED, 'User limit reached for this store', {
        limit: precheckLimit,
        current: precheckActive,
      });
    }

    const rawToken = randomBytes(24).toString('base64url');
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const invitation = await this.uow.execute(async (tx) => {
      // Lock the store row so concurrent creates serialize, then recheck the
      // gate inside the transaction — the pre-check above is TOCTOU-able by
      // itself (two concurrent requests can both pass it before either inserts).
      await this.repo.lockStore(storeId, tx);
      const limit = await this.entitlements.get(accountId, 'max_users_per_store', tx);
      const active = await this.repo.countActiveStaff(storeId, tx);
      if (!this.entitlements.canCreate(limit, active)) {
        throw new ForbiddenError(ErrorCodes.USER_LIMIT_REACHED, 'User limit reached for this store', {
          limit,
          current: active,
        });
      }

      const created = await this.repo.create({
        storeFk:   storeId,
        roleFk:    input.roleId,
        phone:     input.phone,
        email:     input.email,
        token:     tokenHash,
        invitedBy: actorId,
        expiresAt,
      }, tx);
      await this.repo.insertInvitationLocations(created.id, validLocationIds, tx);
      return created;
    });

    // TODO: deliver the invite (SMS via Msg91 / email) — record + token exist now;
    // push/SMS delivery is a separate wiring step (device §27: don't depend on push).

    await this.audit.log({
      event: 'ROLE_ASSIGNMENT_CREATED',
      activityType: 'ROLE_ASSIGNMENT_CREATED',
      prefix: 'Invitation',
      suffix: `created for role "${role.name}"`,
      userId: actorId,
      storeFk: storeId,
      isSuccess: true,
      entityType: 'Invitation',
      entityId: invitation.id,
    });

    // Return the RAW token for delivery — the DB holds only its hash.
    return { id: invitation.id, token: rawToken };
  }

  /**
   * Accept an invitation via its raw token (out-of-band delivery: SMS/email
   * link). The token is hashed before lookup — the DB holds only the hash.
   */
  async accept(token: string, userId: string, ip: string): Promise<AcceptInvitationResult> {
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
    if (!addressedToCaller) throw new NotFoundError(ErrorCodes.INVITATION_NOT_FOUND, 'Invitation not found');

    return this.applyAccept(invitation, userId);
  }

  /** Shared pending/expiry gate for both accept paths. */
  private assertAcceptable(
    invitation: InvitationRow | null,
  ): asserts invitation is InvitationRow {
    if (!invitation) throw new NotFoundError(ErrorCodes.INVITATION_NOT_FOUND, 'Invitation not found');
    if (invitation.status !== 'pending') {
      throw new ConflictError(ErrorCodes.INVITATION_NOT_PENDING, 'This invitation is no longer pending');
    }
    if (invitation.expiresAt < new Date()) {
      throw new ForbiddenError(ErrorCodes.INVITATION_EXPIRED, 'This invitation has expired');
    }
  }

  /** Grant membership/role/locations atomically, then bust caches + audit. */
  private async applyAccept(
    invitation: InvitationRow,
    userId: string,
  ): Promise<AcceptInvitationResult> {
    await this.uow.execute(async (tx) => {
      // markAccepted is the real guard against a concurrent accept()/reject()
      // race on the same invitation — the status check above reads outside this
      // transaction, so both calls can pass it before either commits.
      // Checking the CAS result *before* granting membership/role means a
      // losing call never applies its side effects at all, instead of
      // applying them and then discovering the invitation was already
      // resolved by the other path.
      const accepted = await this.repo.markAccepted(invitation.id, userId, tx);
      if (!accepted) throw new ConflictError(ErrorCodes.INVITATION_NOT_PENDING, 'This invitation is no longer pending');

      await this.repo.ensureAccountMembership(userId, invitation.storeFk, tx);
      await this.repo.assignRole(userId, invitation.roleFk, invitation.storeFk, userId, tx);
      // Apply the invite's location scoping — the invitee is assigned to
      // exactly the locations the owner selected (the "WHERE" gate the
      // LocationGuard reads). Idempotent, so a retried accept is safe.
      const locationIds = await this.repo.listInvitationLocationIds(invitation.id, tx);
      await this.repo.assignLocations(userId, locationIds, userId, tx);
      await this.rbac.bumpPermissionsVersionForRole(invitation.roleFk, invitation.storeFk, tx);
    });
    await this.rbac.invalidateUserStoreCache(userId, invitation.storeFk);
    // Same staleness bug as store creation — the cached bootstrap snapshot
    // must be dropped too, or the newly-joined store won't show up until TTL.
    await this.snapshot.invalidate(userId);

    await this.audit.log({
      event: 'ROLE_ASSIGNMENT_CREATED',
      activityType: 'ROLE_ASSIGNMENT_CREATED',
      prefix: 'Invitation',
      suffix: `accepted`,
      userId,
      storeFk: invitation.storeFk,
      isSuccess: true,
      entityType: 'UserRoleMapping',
      metadata: { invitationId: invitation.id, roleId: invitation.roleFk },
    });

    return { storeId: invitation.storeFk };
  }

  /** Decline an invitation as the authenticated user — same token-as-proof
   *  model as accept(), just no membership/role grant. */
  async reject(token: string, ip: string): Promise<void> {
    await this.rateLimit.checkIpLimit(ip);

    const invitation = await this.repo.findByToken(hashInvitationToken(token));
    if (!invitation) throw new NotFoundError(ErrorCodes.INVITATION_NOT_FOUND, 'Invitation not found');
    if (invitation.status !== 'pending') {
      throw new ConflictError(ErrorCodes.INVITATION_NOT_PENDING, 'This invitation is no longer pending');
    }
    // Same CAS as accept() — if a concurrent accept() already resolved this
    // token, don't silently overwrite its outcome with 'revoked'.
    const revoked = await this.repo.markRevoked(invitation.id);
    if (!revoked) throw new ConflictError(ErrorCodes.INVITATION_NOT_PENDING, 'This invitation is no longer pending');
  }

  /** Decline in-app by id (from GET /me/invitations) — contact-authorized, no token. */
  async rejectById(invitationId: string, userId: string, ip: string): Promise<void> {
    await this.rateLimit.checkIpLimit(ip);

    const invitation = await this.repo.findByIdForContact(invitationId);
    if (!invitation) throw new NotFoundError(ErrorCodes.INVITATION_NOT_FOUND, 'Invitation not found');
    if (invitation.status !== 'pending') {
      throw new ConflictError(ErrorCodes.INVITATION_NOT_PENDING, 'This invitation is no longer pending');
    }
    const contact = await this.repo.findContactForUser(userId);
    const addressedToCaller =
      (!!invitation.phone && invitation.phone === contact?.phone) ||
      (!!invitation.email && invitation.email === contact?.email);
    if (!addressedToCaller) throw new NotFoundError(ErrorCodes.INVITATION_NOT_FOUND, 'Invitation not found');

    const revoked = await this.repo.markRevoked(invitation.id);
    if (!revoked) throw new ConflictError(ErrorCodes.INVITATION_NOT_PENDING, 'This invitation is no longer pending');
  }

  /** Pending invitations addressed to the authenticated user's phone/email. */
  async listMyInvitations(userId: string): Promise<PendingInvitationRow[]> {
    const contact = await this.repo.findContactForUser(userId);
    if (!contact) return [];
    return this.repo.listPendingForContact(contact.phone, contact.email);
  }
}
