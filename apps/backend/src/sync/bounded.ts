/**
 * Runs `fn` over `items` with at most `limit` in flight at once — unlike
 * `Promise.all(items.map(fn))`, which fans out unboundedly and can claim the
 * entire shared, app-wide DB pool from a single call (e.g. per-mutation
 * transactions on the push path, or per-entity keyset reads on the pull path).
 * Order of `results` matches `items`.
 */
export async function runBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}