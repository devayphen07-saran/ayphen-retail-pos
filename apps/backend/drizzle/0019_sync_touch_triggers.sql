-- Sync watermark triggers (sync-engine.md §4/§7, BR-SYNC-002/BR-SYNC-004).
--
-- modified_at and row_version live in the DB, not application code: a
-- hand-written repository method that forgets to bump them would silently
-- break the delta keyset (skipped rows) or the optimistic lock. The trigger
-- makes that impossible.
--
-- row_version is bumped only when the UPDATE didn't change it itself, so a
-- version-gated handler update (SET row_version = row_version + 1 WHERE
-- row_version = $expected) is not double-bumped.
--
-- NOTE: now() is transaction-start time, so a long transaction can commit a
-- row whose modified_at is older than a watermark a concurrent poll already
-- advanced past. The read side compensates with READ_SAFETY_LAG_MS (filters
-- only serve rows older than ~2 s) — keep write transactions short.

CREATE OR REPLACE FUNCTION sync_touch_row() RETURNS trigger AS $$
BEGIN
  NEW.modified_at := now();
  IF NEW.row_version IS NOT DISTINCT FROM OLD.row_version THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_touch_ts() RETURNS trigger AS $$
BEGIN
  NEW.modified_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Writable synced tables: watermark + optimistic-lock version.
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON products         FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
--> statement-breakpoint
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON product_cases    FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
--> statement-breakpoint
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON customers        FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
--> statement-breakpoint
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON suppliers        FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
--> statement-breakpoint
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON units            FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
--> statement-breakpoint
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON taxrates         FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
--> statement-breakpoint
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON payment_methods  FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
--> statement-breakpoint
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON payment_accounts FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
--> statement-breakpoint
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON lookup           FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
--> statement-breakpoint

-- Pull-only synced tables: watermark only.
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON stores              FOR EACH ROW EXECUTE FUNCTION sync_touch_ts();
--> statement-breakpoint
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON store_device_access FOR EACH ROW EXECUTE FUNCTION sync_touch_ts();
--> statement-breakpoint

-- Staff sync watermark: bump only when sync-relevant columns change —
-- last_login_at / failed_login_attempts churn on every login and must not
-- re-deliver the whole staff list to every device (§7 write-amplification).
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON users FOR EACH ROW
  WHEN (
    OLD.name                IS DISTINCT FROM NEW.name OR
    OLD.email               IS DISTINCT FROM NEW.email OR
    OLD.phone               IS DISTINCT FROM NEW.phone OR
    OLD.status              IS DISTINCT FROM NEW.status OR
    OLD.is_blocked          IS DISTINCT FROM NEW.is_blocked OR
    OLD.deleted_at          IS DISTINCT FROM NEW.deleted_at OR
    OLD.permissions_version IS DISTINCT FROM NEW.permissions_version OR
    OLD.image_attachment_fk IS DISTINCT FROM NEW.image_attachment_fk
  )
  EXECUTE FUNCTION sync_touch_ts();
