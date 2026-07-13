/** Milliseconds in one day — the single source for day-based duration math,
 *  so the same concept isn't written as `86_400_000` in one file and
 *  `24 * 60 * 60 * 1000` in another. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;