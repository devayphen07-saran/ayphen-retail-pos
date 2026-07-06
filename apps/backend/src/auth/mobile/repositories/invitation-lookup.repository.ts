import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '#db/db.module.js';
import * as schema from '#db/schema.js';
import { invitations } from '#db/schema.js';

/**
 * Read-only invitation lookups for the mobile-auth track.
 *
 * Invitations aren't keyed by userFk (the invitee may have no account at invite
 * time) — they're matched by phone/email. This mirrors the stores module's
 * `listPendingForContact`, kept here so auth/mobile carries no dependency on
 * the stores module.
 */
@Injectable()
export class InvitationLookupRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async countPendingForContact(
    phone: string | null,
    email: string | null,
  ): Promise<number> {
    if (!phone && !email) return 0;

    const contactMatch = [];
    if (phone) contactMatch.push(eq(invitations.phone, phone));
    if (email) contactMatch.push(eq(invitations.email, email));

    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(invitations)
      .where(
        and(
          eq(invitations.status, 'pending'),
          gt(invitations.expiresAt, new Date()),
          or(...contactMatch),
        ),
      );

    return row?.n ?? 0;
  }
}
