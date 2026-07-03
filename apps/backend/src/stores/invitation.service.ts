import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { UnitOfWork } from '#db/db.module.js';
import { InvitationRepository, type PendingInvitationRow } from './invitation.repository.js';
import { RoleRepository } from './role.repository.js';
import { EntitlementService } from '../subscription/entitlement.service.js';
import { RbacService } from '#common/rbac/rbac.service.js';
import { AuditService } from '#auth/core/audit.service.js';
import { SnapshotService } from '#auth/mobile/services/snapshot.service.js';

const SYSTEM_ROLE_CODES = new Set(['USER', 'STORE_OWNER', 'SUPER_ADMIN']);
const INVITE_TTL_DAYS = 7;

export interface CreateInvitationInput {
  roleId: string;
  phone?: string;
  email?: string;
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
  ) {}

  async create(
    storeId: string,
    accountId: string,
    actorId: string,
    input: CreateInvitationInput,
  ): Promise<{ id: string; token: string }> {
    if (!input.phone && !input.email) {
      throw new ConflictException('INVITATION_CONTACT_REQUIRED');
    }

    // Only custom roles of this store are invitable (BR-RBAC-006).
    const role = await this.roleRepo.findRoleInStore(input.roleId, storeId);
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
    if (SYSTEM_ROLE_CODES.has(role.code)) {
      throw new ForbiddenException('ROLE_NOT_ASSIGNABLE');
    }

    // max_users_per_store gate (subscription §10). Fast pre-check outside the
    // transaction for quick feedback on the common case.
    const precheckLimit = await this.entitlements.get(accountId, 'max_users_per_store');
    const precheckActive = await this.repo.countActiveStaff(storeId);
    if (!this.entitlements.canCreate(precheckLimit, precheckActive)) {
      throw new ForbiddenException('USER_LIMIT_REACHED');
    }

    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const invitation = await this.uow.execute(async (tx) => {
      // Lock the store row so concurrent creates serialize, then recheck the
      // gate inside the transaction — the pre-check above is TOCTOU-able by
      // itself (two concurrent requests can both pass it before either inserts).
      await this.repo.lockStore(storeId, tx);
      const limit = await this.entitlements.get(accountId, 'max_users_per_store', tx);
      const active = await this.repo.countActiveStaff(storeId, tx);
      if (!this.entitlements.canCreate(limit, active)) {
        throw new ForbiddenException('USER_LIMIT_REACHED');
      }

      return this.repo.create({
        storeFk:   storeId,
        roleFk:    input.roleId,
        phone:     input.phone,
        email:     input.email,
        token,
        invitedBy: actorId,
        expiresAt,
      }, tx);
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

    return invitation;
  }

  /** Accept an invitation as the authenticated user. */
  async accept(token: string, userId: string): Promise<{ storeId: string }> {
    const invitation = await this.repo.findByToken(token);
    if (!invitation) throw new NotFoundException('INVITATION_NOT_FOUND');
    if (invitation.status !== 'pending') {
      throw new ConflictException('INVITATION_NOT_PENDING');
    }
    if (invitation.expiresAt < new Date()) {
      throw new ForbiddenException('INVITATION_EXPIRED');
    }

    await this.uow.execute(async (tx) => {
      await this.repo.ensureAccountMembership(userId, invitation.storeFk, tx);
      await this.repo.assignRole(userId, invitation.roleFk, invitation.storeFk, userId, tx);
      await this.repo.markAccepted(invitation.id, userId, tx);
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
  async reject(token: string): Promise<void> {
    const invitation = await this.repo.findByToken(token);
    if (!invitation) throw new NotFoundException('INVITATION_NOT_FOUND');
    if (invitation.status !== 'pending') {
      throw new ConflictException('INVITATION_NOT_PENDING');
    }
    await this.repo.markRevoked(invitation.id);
  }

  /** Pending invitations addressed to the authenticated user's phone/email. */
  async listMyInvitations(userId: string): Promise<PendingInvitationRow[]> {
    const contact = await this.repo.findContactForUser(userId);
    if (!contact) return [];
    return this.repo.listPendingForContact(contact.phone, contact.email);
  }
}
