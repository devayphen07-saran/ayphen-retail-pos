import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE, type DbExecutor } from '#db/db.module.js';
import { requireRow } from '#db/require-row.js';
import * as schema from '#db/schema.js';
import { otpRequests } from '#db/schema.js';

export type OtpPurpose = 'login' | 'signup' | 'step_up';
export type OtpRequest = typeof otpRequests.$inferSelect;

@Injectable()
export class OtpRequestRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async insert(data: {
    phone:       string;
    purpose:     OtpPurpose;
    maxAttempts: number;
    expiresAt:   Date;
  }, tx?: DbExecutor): Promise<OtpRequest> {
    const [row] = await (tx ?? this.db).insert(otpRequests).values(data).returning();
    return requireRow(row);
  }

  /**
   * An active (unconsumed, unexpired) OTP request for this id+phone, scoped to
   * the flow that minted it. The `purpose` filter is a security control: without
   * it, an OTP issued for one flow (e.g. `signup`) would satisfy another's
   * verify (e.g. `login`), enabling cross-flow reachability / account
   * enumeration. Callers pass the purpose they expect for their flow.
   */
  async findActiveRequest(
    id: string,
    phone: string,
    purpose: OtpPurpose,
  ): Promise<OtpRequest | null> {
    const [row] = await this.db
      .select()
      .from(otpRequests)
      .where(and(
        eq(otpRequests.id, id),
        eq(otpRequests.phone, phone),
        eq(otpRequests.purpose, purpose),
        isNull(otpRequests.consumedAt),
        gt(otpRequests.expiresAt, new Date()),
      ));
    return row ?? null;
  }

  /**
   * Looked up by id for the resend-cooldown check. `phone` is optional so
   * existing unscoped call sites keep working, but callers that already know
   * the expected phone should pass it — otherwise a caller-supplied id from
   * another phone's OTP flow would still resolve here.
   */
  async findById(id: string, phone?: string): Promise<OtpRequest | null> {
    const [row] = await this.db
      .select()
      .from(otpRequests)
      .where(phone ? and(eq(otpRequests.id, id), eq(otpRequests.phone, phone)) : eq(otpRequests.id, id));
    return row ?? null;
  }

  /**
   * Most recent OTP request row for this phone+purpose. Used to enforce the
   * resend cooldown unconditionally — a caller that simply omits `resendOf`
   * must not skip the cooldown check, so the server looks up the latest row
   * itself instead of trusting a (missing or client-supplied) id.
   */
  async findLatestForPhone(phone: string, purpose: OtpPurpose): Promise<OtpRequest | null> {
    const [row] = await this.db
      .select()
      .from(otpRequests)
      .where(and(eq(otpRequests.phone, phone), eq(otpRequests.purpose, purpose)))
      .orderBy(desc(otpRequests.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Atomically increment `attempts`, but only while still under `maxAttempts`.
   * The guard lives in the `WHERE` clause (not a separate read-then-write), so
   * concurrent verify calls for the same OTP serialize on the row and can never
   * jointly exceed the configured attempt cap. Returns the post-increment
   * count too, so the caller can tell the user how many tries are left.
   */
  async incrementAttemptsIfUnderLimit(
    id: string,
  ): Promise<{ underLimit: boolean; attempts: number; maxAttempts: number }> {
    const rows = await this.db
      .update(otpRequests)
      .set({ attempts: sql`${otpRequests.attempts} + 1` })
      .where(and(
        eq(otpRequests.id, id),
        sql`${otpRequests.attempts} < ${otpRequests.maxAttempts}`,
      ))
      .returning({ id: otpRequests.id, attempts: otpRequests.attempts, maxAttempts: otpRequests.maxAttempts });
    if (rows.length > 0) {
      return { underLimit: true, attempts: rows[0].attempts, maxAttempts: rows[0].maxAttempts };
    }
    // Already at the limit — the WHERE excluded the row, so re-read for the
    // count to report (attempts/maxAttempts are immutable-once-set here, so
    // this can't race with the update above in a way that changes the answer).
    const [row] = await this.db
      .select({ attempts: otpRequests.attempts, maxAttempts: otpRequests.maxAttempts })
      .from(otpRequests)
      .where(eq(otpRequests.id, id));
    return { underLimit: false, attempts: row?.attempts ?? 0, maxAttempts: row?.maxAttempts ?? 0 };
  }

  async markConsumed(id: string): Promise<void> {
    await this.db
      .update(otpRequests)
      .set({ consumedAt: new Date() })
      .where(eq(otpRequests.id, id));
  }
}
