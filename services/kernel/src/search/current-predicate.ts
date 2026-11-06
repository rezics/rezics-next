/**
 * One executed current predicate. Hits, exclusion, order and facet consumers share this
 * disclosed sequence. A later census, sample or sibling query cannot replace it.
 *
 * Cost
 * - Touches: the already current-disclosed map from `currentDiscoveryCandidates` /
 *   `checkHits`, plus the engine window's examined identities and exhaustion bit.
 * - Bound: one linear pass over `examined <= min(600, 6L+3)` candidates and at most `L`
 *   disclosed hits. No Source, engine or owner I/O.
 * - Growth check: `test/search/current-predicate.test.ts` covers hidden/taken-down drops,
 *   exclusion of stale positives, trailing consumed rejects, stable remaining order and
 *   shared facet consumers.
 */

export type CurrentPredicateKey = Readonly<{
  owner: string;
  kind: string;
  id: string;
}>;

export type CurrentPredicateHit = Readonly<{
  key: CurrentPredicateKey;
}>;

export type CurrentPredicateSelection<Hit extends CurrentPredicateHit> = Readonly<{
  hits: readonly Hit[];
  /** Examined candidates that current disclosure refused, including duplicates. */
  dropped: number;
  /** Distinct current canonical identities per kind, in first-seen order. */
  witnesses: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Examined prefix through the last consumed candidate. Unused useful lookahead is
   * excluded; trailing rejects and duplicates after a filled page stay consumed.
   */
  consumed: number;
  /** True when this window filled the admitted page or the executed predicate is exhausted. */
  useful: boolean;
  exhausted: boolean;
}>;

export function predicateIdentity(key: CurrentPredicateKey): string {
  return `${key.owner}:${key.kind}:${key.id}`;
}

export function collectCurrentPredicateHits<Candidate, Hit extends CurrentPredicateHit>(
  examined: readonly Candidate[],
  disclosed: ReadonlyMap<Candidate, Hit>,
  options: Readonly<{
    seen?: Set<string>;
    identity?: (candidate: Candidate, hit: Hit | undefined) => string | undefined;
    /** When set, stop before the next useful identity after this many hits. */
    limit?: number;
  }> = {},
): Pick<CurrentPredicateSelection<Hit>, 'hits' | 'dropped' | 'witnesses' | 'consumed'> {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1))
    throw new RangeError('Current predicate limits must be a positive safe integer');
  const seen = options.seen ?? new Set<string>();
  const hits: Hit[] = [];
  const witnesses = new Map<string, Set<string>>();
  let dropped = 0;
  let consumed = 0;
  const identityOf =
    options.identity ??
    ((candidate: Candidate, hit: Hit | undefined) => (hit ? predicateIdentity(hit.key) : undefined));
  for (const candidate of examined) {
    const hit = disclosed.get(candidate);
    const identity = identityOf(candidate, hit);
    if (!hit || identity === undefined) {
      dropped++;
      consumed++;
      continue;
    }
    if (seen.has(identity)) {
      dropped++;
      consumed++;
      continue;
    }
    if (options.limit !== undefined && hits.length === options.limit) break;
    seen.add(identity);
    hits.push(hit);
    const ids = witnesses.get(hit.key.kind) ?? new Set<string>();
    ids.add(hit.key.id);
    witnesses.set(hit.key.kind, ids);
    consumed++;
  }
  return { hits, dropped, witnesses, consumed };
}

export function selectCurrentPredicatePage<Candidate, Hit extends CurrentPredicateHit>(
  examined: readonly Candidate[],
  disclosed: ReadonlyMap<Candidate, Hit>,
  options: Readonly<{
    limit: number;
    exhausted: boolean;
    seen?: Set<string>;
    identity?: (candidate: Candidate, hit: Hit | undefined) => string | undefined;
  }>,
): CurrentPredicateSelection<Hit> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
    throw new RangeError('Current predicate pages admit 1 through 100 hits');
  const selected = collectCurrentPredicateHits(examined, disclosed, {
    limit: options.limit,
    ...(options.seen ? { seen: options.seen } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
  });
  return {
    ...selected,
    useful: selected.hits.length === options.limit || options.exhausted,
    exhausted: options.exhausted,
  };
}

export function kindWitnessCounts(witnesses: ReadonlyMap<string, ReadonlySet<string>>): Map<string, number> {
  return new Map([...witnesses].map(([kind, ids]) => [kind, ids.size]));
}

/** Facet consumers reuse the same disclosed identities; they do not re-sample the engine. */
export function currentPredicateFacetHits<Hit extends CurrentPredicateHit>(
  selection: Pick<CurrentPredicateSelection<Hit>, 'hits'>,
): readonly Hit[] {
  return selection.hits;
}
