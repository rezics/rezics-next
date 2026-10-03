/** Fixture waits must identify the missing stage before the shard deadline. */
export async function fixtureDeadline<T>(pending: Promise<T>, stage: string, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${stage} did not finish within ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Bounds come from this fixture's population, never from the shared database. */
export function fixturePages(stage: string, maximumItems: number) {
  const items = new Set<string>(), cursors = new Set<string>();
  let pages = 0;
  return (ids: readonly string[], next: string | null) => {
    if (++pages > maximumItems + 1) throw new Error(`${stage} exceeded its ${maximumItems + 1}-page fixture bound`);
    if (!ids.length && next) throw new Error(`${stage} returned an empty page with a continuation`);
    for (const id of ids) {
      if (items.has(id)) throw new Error(`${stage} repeated fixture item ${id}`);
      items.add(id);
    }
    if (items.size > maximumItems) throw new Error(`${stage} exceeded its ${maximumItems}-item fixture population`);
    if (next) {
      if (cursors.has(next)) throw new Error(`${stage} repeated a continuation cursor`);
      cursors.add(next);
    }
  };
}
