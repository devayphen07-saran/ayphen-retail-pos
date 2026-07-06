-- Attach the sync watermark trigger to locations (sync-engine.md §4/§7),
-- matching units/taxrates: pull-only for now, but row_version-bumping so a
-- future mutation handler doesn't need another migration to add it.
CREATE TRIGGER trg_sync_touch BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION sync_touch_row();
