import { DisclosureUnavailable, DISCLOSURE_COST } from './read.ts';

export const ADMITTED_PAGE_COST = {
  candidates: DISCLOSURE_COST.batch,
  scans: 64,
  page: 500,
} as const;

/** Scan keyset batches, admitting before selection. Raw seek positions remain
 * internal; only an admitted lookahead can establish a continuation. Each scan
 * uses one bounded admission batch, never one query per candidate. Exhausting
 * the work budget fails closed instead of claiming an empty or terminal page.
 * Ordering must be unique: https://www.postgresql.org/docs/current/queries-limit.html
 * Callers retain their graph/owner position fences across the entire scan. */
export async function admittedPage<T>(input: {
  limit: number;
  after?: T;
  key: (row: T) => string;
  fetch: (after: T | undefined, size: number) => Promise<T[]>;
  admit: (rows: T[]) => Promise<T[]>;
}) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > ADMITTED_PAGE_COST.page) {
    throw new DisclosureUnavailable('Admitted page limit is invalid');
  }
  const selected: T[] = [],
    seen = new Set<string>();
  let after = input.after;
  if (after) seen.add(input.key(after));
  for (let scan = 0; scan < ADMITTED_PAGE_COST.scans; scan++) {
    const rows = await input.fetch(after, ADMITTED_PAGE_COST.candidates);
    if (
      rows.length > ADMITTED_PAGE_COST.candidates ||
      rows.some((row) => seen.has(input.key(row))) ||
      new Set(rows.map(input.key)).size !== rows.length
    ) {
      throw new DisclosureUnavailable('Admitted page candidates are ambiguous');
    }
    rows.forEach((row) => seen.add(input.key(row)));
    const admitted = rows.length ? await input.admit(rows) : [];
    if (
      new Set(admitted.map(input.key)).size !== admitted.length ||
      admitted.some((row) => !rows.includes(row))
    ) {
      throw new DisclosureUnavailable('Admitted page selection is invalid');
    }
    selected.push(...admitted);
    if (selected.length > input.limit || rows.length < ADMITTED_PAGE_COST.candidates) {
      const page = selected.slice(0, input.limit);
      return { page, lookahead: selected[input.limit], last: page.at(-1) };
    }
    after = rows.at(-1);
  }
  throw new DisclosureUnavailable('Admitted page scan budget exceeded');
}
