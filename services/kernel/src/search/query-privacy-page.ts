import {
  selectCurrentPredicatePage,
  collectCurrentPredicateHits,
  type CurrentPredicateHit,
  type CurrentPredicateSelection,
} from './current-predicate.ts';
import type { HitOptions, SearchHit } from './hits.ts';
import { projectFacts, projectHit, revalidateProjectedHits } from './hits.ts';
import type { IndexedSubject, SubjectSource } from './source.ts';
import {
  queryPrivacyPreparing,
  queryPrivacyProofs,
  type QueryPrivacyCursorProof,
  type QueryPrivacyDecision,
  type QueryPrivacyProofSet,
} from './query-privacy.ts';

/**
 * One executed current page: membership, exclusion, remaining order and displayed fields after
 * nested facet or label reads. Preparing currentness never becomes a successful empty page.
 *
 * Cost
 * - Touches: the already disclosed candidate map, optional nested reads supplied by the caller,
 *   then one current Source re-read of accepted identities and their requested fact targets.
 * - Bound: `examined <= min(600, 6L+3)` candidates, at most `L` hits, at most four requested
 *   properties and the existing 256-key Source batches. No engine census.
 * - Growth check: `test/search/query-privacy-page.test.ts` covers hidden/taken-down drops, withheld
 *   facts, public-to-private hydration, nested label revalidation, sort stability, empty pages,
 *   cursor replay and refused empty substitutes.
 */

export type QueryPrivacyExaminedHit = CurrentPredicateHit &
  Readonly<{
    sort: readonly (string | number | null)[];
    subject?: IndexedSubject;
  }>;

export type QueryPrivacyDisclosedHit = QueryPrivacyExaminedHit &
  Readonly<{
    subject: IndexedSubject;
    projected: SearchHit;
  }>;

export type QueryPrivacyPage = Readonly<{
  status: 'ready' | 'preparing';
  hits: readonly QueryPrivacyDisclosedHit[];
  dropped: number;
  consumed: number;
  useful: boolean;
  exhausted: boolean;
  empty: boolean;
  order: readonly string[];
  proofs: QueryPrivacyProofSet;
  selection: CurrentPredicateSelection<QueryPrivacyDisclosedHit> | null;
}>;

function visible(subject: IndexedSubject | undefined): subject is IndexedSubject {
  return subject !== undefined && subject.visibility === 'visible' && subject.redirect === null;
}

function disclosedMap(
  examined: readonly QueryPrivacyExaminedHit[],
  subjects: ReadonlyMap<QueryPrivacyExaminedHit, IndexedSubject>,
  options: HitOptions,
): Map<QueryPrivacyExaminedHit, QueryPrivacyDisclosedHit> {
  const disclosed = new Map<QueryPrivacyExaminedHit, QueryPrivacyDisclosedHit>();
  for (const candidate of examined) {
    // An attached engine row is a nomination, never a substitute for refused current evidence.
    const subject = subjects.get(candidate);
    if (!visible(subject)) continue;
    disclosed.set(candidate, {
      ...candidate,
      key: { ...candidate.key, kind: subject.type, id: subject.id },
      subject,
      projected: projectHit(subject, options),
    });
  }
  return disclosed;
}

function preparingPage(proofs: QueryPrivacyProofSet): QueryPrivacyPage {
  return {
    status: 'preparing',
    hits: [],
    dropped: 0,
    consumed: 0,
    useful: false,
    exhausted: false,
    empty: false,
    order: [],
    proofs,
    selection: null,
  };
}

export async function discloseQueryPrivacyPage(options: {
  currentness: QueryPrivacyDecision;
  examined: readonly QueryPrivacyExaminedHit[];
  subjects: ReadonlyMap<QueryPrivacyExaminedHit, IndexedSubject>;
  limit: number;
  exhausted: boolean;
  continuation?: boolean;
  cursor?: { observation: string; execution?: string; consumed: number };
  kinds?: Iterable<string>;
  aggregateProof?: boolean;
  languages?: readonly string[];
  properties?: readonly string[];
  descriptions?: boolean;
  source?: SubjectSource;
  /** Nested facet or label work. Final disclosure always re-reads after it. */
  nested?: (hits: readonly QueryPrivacyDisclosedHit[]) => Promise<void>;
}): Promise<QueryPrivacyPage> {
  const continuation = options.continuation === true;
  const kinds = [...(options.kinds ?? [])];
  const emptyProofs = queryPrivacyProofs({
    currentness: options.currentness,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    kinds,
    witnesses: new Map(),
    continuation,
    exhausted: false,
    aggregateProof: false,
  });
  if (queryPrivacyPreparing(options.currentness)) return preparingPage(emptyProofs);
  const hitOptions: HitOptions = {
    descriptions: options.descriptions === true,
    ...(options.languages === undefined ? {} : { languages: options.languages }),
    ...(options.properties === undefined ? {} : { properties: options.properties }),
  };
  const disclosed = disclosedMap(options.examined, options.subjects, hitOptions);
  const selected = selectCurrentPredicatePage(options.examined, disclosed, {
    limit: options.limit,
    exhausted: options.exhausted,
  });
  let hits = selected.hits;
  if (options.nested) await options.nested(hits);
  if (options.source) {
    const current = await revalidateProjectedHits(
      options.source,
      hits.map((hit) => hit.subject),
      hitOptions,
    );
    const remaining: QueryPrivacyDisclosedHit[] = [];
    for (const hit of hits) {
      const projected = current.get(hit.subject.id);
      if (!projected) continue;
      remaining.push({ ...hit, subject: projected.subject, projected: projected.hit });
    }
    hits = remaining;
  } else if (options.properties?.length) {
    const facts = await projectFacts(
      {
        async read() {
          throw new Error('Displayed facts require a current Source after nested reads');
        },
        async count() {
          throw new Error('Displayed facts require a current Source after nested reads');
        },
      },
      hits.map((hit) => hit.subject),
      options.properties,
      options.languages,
    );
    hits = hits.map((hit, index) => ({
      ...hit,
      projected: { ...hit.projected, ...(Object.keys(facts[index] ?? {}).length ? { facts: facts[index] } : {}) },
    }));
  }
  // Final Source disclosure can remove identities. All facet and kind consumers must
  // see that same final sequence, including its updated witnesses and exhaustion.
  const final = collectCurrentPredicateHits(hits, new Map(hits.map((hit) => [hit, hit])));
  const identities = final.witnesses;
  const exhausted = options.exhausted && selected.consumed === options.examined.length;
  const useful = hits.length === options.limit || exhausted;
  const witnesses = new Map([...identities].map(([kind, ids]) => [kind, ids.size]));
  const proofs = queryPrivacyProofs({
    currentness: options.currentness,
    ...(options.cursor === undefined ? {} : { cursor: { ...options.cursor, consumed: selected.consumed } }),
    kinds: kinds.length ? kinds : witnesses.keys(),
    witnesses,
    continuation,
    exhausted,
    aggregateProof: options.aggregateProof === true,
  });
  return {
    status: 'ready',
    hits,
    dropped: selected.dropped + (selected.hits.length - hits.length),
    consumed: selected.consumed,
    useful,
    exhausted,
    empty: hits.length === 0,
    order: hits.map((hit) => hit.key.id),
    proofs,
    selection: {
      ...selected,
      hits,
      witnesses: identities,
      dropped: selected.dropped + selected.hits.length - hits.length,
      exhausted,
      useful,
    },
  };
}

export function queryPrivacyOrderUnchanged(before: readonly string[], after: readonly string[]): boolean {
  let index = 0;
  for (const id of after) {
    const found = before.indexOf(id, index);
    if (found === -1) return false;
    index = found + 1;
  }
  return true;
}

export function replayQueryPrivacyPageCursor(
  admitted: QueryPrivacyCursorProof,
  currentness: QueryPrivacyDecision,
): 'continue' | 'restart' | 'preparing' {
  if (queryPrivacyPreparing(currentness)) return currentness.reason === 'blocking' ? 'restart' : 'preparing';
  return admitted.consumed >= 0 ? 'continue' : 'restart';
}

/** An empty ready page still requires currentness; missing coverage is preparing. */
export function queryPrivacyEmptyPage(currentness: QueryPrivacyDecision, exhausted: boolean): QueryPrivacyPage {
  if (queryPrivacyPreparing(currentness))
    return preparingPage(
      queryPrivacyProofs({
        currentness,
        kinds: [],
        witnesses: new Map(),
        continuation: false,
        exhausted: false,
        aggregateProof: false,
      }),
    );
  return {
    status: 'ready',
    hits: [],
    dropped: 0,
    consumed: 0,
    useful: exhausted,
    exhausted,
    empty: true,
    order: [],
    proofs: queryPrivacyProofs({
      currentness,
      kinds: [],
      witnesses: new Map(),
      continuation: false,
      exhausted,
      aggregateProof: exhausted,
    }),
    selection: { hits: [], dropped: 0, witnesses: new Map(), consumed: 0, useful: exhausted, exhausted },
  };
}
