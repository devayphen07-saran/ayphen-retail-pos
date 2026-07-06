import { SetMetadata } from '@nestjs/common';

export const SKIP_TRANSFORM_KEY = 'skipTransform';

/**
 * Bypass the global `ResponseInterceptor` envelope for this route/class.
 * Sync endpoints return their PRD wire shapes verbatim (sync-engine.md §2) —
 * the client parses `{ changes, sync_cursor, ... }` at the top level, not
 * wrapped in `{ success, data }`.
 */
export const SkipTransform = () => SetMetadata(SKIP_TRANSFORM_KEY, true);