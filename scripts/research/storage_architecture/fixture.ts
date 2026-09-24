/** Deterministic synthetic research fixture; never a product acceptance dataset. */
export const PREFIX = 'https://rezics.test/architecture/';
export const P = `${PREFIX}p/`;
export const R = `${PREFIX}r/`;
export const work = (i: number) => `${R}work/${i}`;
export const tag = (i: number) => `${R}tag/${i}`;
export const revision = (i: number) => `${R}revision/${i}`;
export const realm = `${R}realm/1`;
export type Override = 'accept' | 'reject' | null;
export type Work = { id: number; title: string; tag: number; revision: number; baseline: boolean; override: Override; related: number[]; payload: string };

export function fixtureWork(i: number, size: number): Work {
  if (!Number.isInteger(i) || i < 0 || i >= size) throw new RangeError('work index');
  const hot = Math.max(100, Math.min(1000, Math.floor(size / 20)));
  const related = new Set<number>([(i + 1) % size, (i * 37 + 13) % size]);
  if (i < hot) related.add(0);
  if (i === 0) for (let j = 1; j <= hot; j++) related.add(j);
  return {
    id: i, title: `Work ${i.toString().padStart(6, '0')}`, tag: (i * 73 + 17) % 256,
    revision: i * 3 + 2, baseline: i % 7 !== 0,
    override: i % 29 === 0 ? 'reject' : i % 31 === 0 ? 'accept' : null,
    related: [...related].filter(j => j !== i),
    payload: JSON.stringify({ work: i, revision: i * 3 + 2, text: `Synthetic revision body ${i}` }),
  };
}

export function effective(w: Work): boolean {
  return w.override === 'accept' ? true : w.override === 'reject' ? false : w.baseline;
}

export function tagParent(i: number): number | null { return i === 0 ? null : Math.floor((i - 1) / 4); }

export function oracle(size: number, ids: number[]) {
  return ids.map(i => {
    const w = fixtureWork(i, size);
    return { id: i, title: w.title, tag: w.tag, parent: tagParent(w.tag), revision: w.revision,
      baseline: w.baseline, override: w.override, effective: effective(w), payload: w.payload };
  });
}

export const sampleIds = (size: number) => [0, 1, 7, 29, 31, 203, 899, 1789, 2501, 3457, 5003, 7001, 8009, 9001, size - 2, size - 1]
  .filter((id, index, all) => id < size && all.indexOf(id) === index);

export function reachable(size: number, start: number, hops: number): Set<number> {
  let frontier = new Set([start]);
  for (let step = 0; step < hops; step++) {
    const next = new Set<number>();
    for (const id of frontier) for (const target of fixtureWork(id, size).related) next.add(target);
    frontier = next;
  }
  return frontier;
}
