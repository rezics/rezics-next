/** Keep the native fetch callable's Bun connection API on deterministic HTTP fixtures. */
export function fixtureFetch(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: fetch.preconnect });
}

/** These publication fixtures expect complete retained candidates, never deletion tombstones. */
export function retainedCandidates<C extends { id: string }>(
  candidates: readonly C[],
): Exclude<C, { deleted: true }>[] {
  return candidates.map((candidate) => {
    assertRetained(candidate);
    return candidate;
  });
}

function assertRetained<C extends { id: string }>(candidate: C): asserts candidate is Exclude<C, { deleted: true }> {
  if ('deleted' in candidate) throw new Error(`Unexpected deleted candidate ${candidate.id}`);
}

/** Candidate ranks are the native read projection of the current adoption selection. */
export function adoptedCandidates<C extends { id: string; rank: string | null }>(page: {
  adoption: { mode: string; head: number } | null;
  candidates: readonly (C | { id: string; deleted: true })[];
}) {
  if (page.adoption === null) return undefined;
  return retainedCandidates(page.candidates).flatMap((candidate) =>
    candidate.rank === null ? [] : [{ candidate: candidate.id, rank: candidate.rank }],
  );
}

/** A fixture expecting an ordinary value must fail when the native response carries a special value. */
export function valueContent<T>(value: { type: 'value'; content: T } | { type: 'somevalue' | 'novalue' }): T {
  if (value.type !== 'value') throw new Error(`Expected value, received ${value.type}`);
  return value.content;
}
