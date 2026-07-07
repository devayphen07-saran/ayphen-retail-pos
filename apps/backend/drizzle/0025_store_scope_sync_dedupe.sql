-- sync_mutation_failures holds only transient poison-mutation retry counters
-- (S-7) — no downstream reads depend on historical values, and losing an
-- in-progress count just resets a mutation's failure budget, which the
-- bounded-retry design already treats as a safe, self-healing outcome.
-- Truncating first lets store_fk land as NOT NULL with no backfill needed.
TRUNCATE TABLE "sync_mutation_failures";--> statement-breakpoint
ALTER TABLE "sync_mutation_failures" DROP CONSTRAINT "sync_mutation_failures_mutation_id_user_fk_pk";--> statement-breakpoint
ALTER TABLE "sync_mutation_idempotency" DROP CONSTRAINT "sync_mutation_idempotency_mutation_id_user_fk_pk";--> statement-breakpoint
ALTER TABLE "sync_mutation_failures" ADD COLUMN "store_fk" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_mutation_failures" ADD CONSTRAINT "sync_mutation_failures_store_fk_stores_id_fk" FOREIGN KEY ("store_fk") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_mutation_failures" ADD CONSTRAINT "sync_mutation_failures_mutation_id_user_fk_store_fk_pk" PRIMARY KEY("mutation_id","user_fk","store_fk");--> statement-breakpoint
ALTER TABLE "sync_mutation_idempotency" ADD CONSTRAINT "sync_mutation_idempotency_mutation_id_user_fk_store_fk_pk" PRIMARY KEY("mutation_id","user_fk","store_fk");--> statement-breakpoint
DROP INDEX "uk_sync_conflicts_mutation";--> statement-breakpoint
CREATE UNIQUE INDEX "uk_sync_conflicts_mutation" ON "sync_conflicts" USING btree ("mutation_id","user_fk","store_fk");