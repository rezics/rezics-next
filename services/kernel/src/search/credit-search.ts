import { isDeepStrictEqual } from 'node:util';
import type { LanguageValue } from './source.ts';

/** Limits are passed to the native reader BEFORE it expands credits or creator labels. */
export const CREDIT_SEARCH_LIMITS = Object.freeze({
  pages: 4,
  creditsPerPage: 32,
  namesPerCreator: 16,
  qualifiersPerCredit: 4,
  nameBytes: 256,
  documentBytes: 131072,
  pageBytes: 65536,
});

export type CreditSearchQualifier = Readonly<{ property: string; value: string }>;
/** Native selection, not an inferred inverse or a source-reported literal credit. */
export type CreditSearchWitness = Readonly<{
  workId: string;
  statementId: string;
  revision: number;
  release: string;
  property: string;
  targetId: string;
  direction: 'outgoing';
  qualifiers: readonly CreditSearchQualifier[];
  /** Native creator identity/name selection; changes on merge, concealment and rename. */
  nameRevision: string;
  name: LanguageValue;
}>;
export type CreditSearchEntry = Readonly<{
  witness: Omit<CreditSearchWitness, 'name'>;
  /** Complete public labels and aliases, independently bounded for each target. */
  names: readonly LanguageValue[];
  namesComplete: boolean;
}>;
export type CreditSearchPage =
  | Readonly<{ state: 'preparing' | 'unsupported' | 'unavailable' }>
  | Readonly<{
      state: 'current';
      workId: string;
      /** Binds the complete work selection AND all creator dependencies for this traversal. */
      observation: string;
      entries: readonly CreditSearchEntry[];
      next: string | null;
    }>;

/** Minimal consumer seam. The Semantic adapter owns released credit meaning and native disclosure.
 * Implementations use native indexed seeks, never the three-entry work-context preview. They must
 * charge raw examined rows and nested label work against these bounds before performing the read.
 * Missing native support is unavailable, never a complete empty page. */
export interface CreditSearchSource {
  page(input: Readonly<{
    workId: string;
    after: string | null;
    observation: string | null;
    limits: typeof CREDIT_SEARCH_LIMITS;
  }>): Promise<CreditSearchPage>;
  /** Exact current statement, directed target, qualifiers, release, name and both disclosures.
   * The receiving page must retain this observation through its final native disclosure guard. */
  current(witness: CreditSearchWitness, observation: string): Promise<boolean | 'unavailable'>;
  /** Whole dependency cut, including removed credits and creators omitted by an earlier page. */
  unchanged(workId: string, observation: string): Promise<boolean>;
}
export type CreditSearchProjection =
  | Readonly<{ state: 'preparing' | 'unsupported' | 'unavailable' | 'incomplete' | 'restart' }>
  | Readonly<{
      state: 'complete';
      workId: string;
      observation: string;
      names: readonly CreditSearchWitness[];
    }>;
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const bounded = (value: string, max = 256) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed() &&
  encoder.encode(value).byteLength <= max;

function validEntry(entry: CreditSearchEntry, workId: string): boolean {
  const w = entry.witness;
  return w.workId === workId && w.direction === 'outgoing' &&
    [w.workId, w.statementId, w.release, w.property, w.targetId, w.nameRevision].every((s) => bounded(s)) &&
    Number.isSafeInteger(w.revision) && w.revision > 0 &&
    w.qualifiers.length <= CREDIT_SEARCH_LIMITS.qualifiersPerCredit &&
    w.qualifiers.every((q) => bounded(q.property) && bounded(q.value)) &&
    entry.names.length <= CREDIT_SEARCH_LIMITS.namesPerCreator &&
    entry.names.every((name) => bounded(name.language, 35) && bounded(name.value, CREDIT_SEARCH_LIMITS.nameBytes));
}

/** All-or-readiness: a prefix never becomes a definitive negative for a credited-name query. */
export async function projectCreditSearch(
  source: CreditSearchSource | undefined,
  workId: string,
): Promise<CreditSearchProjection> {
  if (!source) return { state: 'unavailable' };
  let after: string | null = null;
  let observation: string | null = null;
  const cursors = new Set<string>();
  const statements = new Set<string>();
  const names: CreditSearchWitness[] = [];
  let material = 0;
  for (let pageNumber = 0; pageNumber < CREDIT_SEARCH_LIMITS.pages; pageNumber++) {
    const page = await source.page({ workId, after, observation, limits: CREDIT_SEARCH_LIMITS });
    if (page.state !== 'current') return { state: page.state };
    if (page.entries.length > CREDIT_SEARCH_LIMITS.creditsPerPage || bytes(page) > CREDIT_SEARCH_LIMITS.pageBytes)
      return { state: 'incomplete' };
    if (page.workId !== workId || !bounded(page.observation, 1024)) return { state: 'unavailable' };
    if (observation !== null && observation !== page.observation) return { state: 'restart' };
    observation = page.observation;
    for (const entry of page.entries) {
      if (entry.names.length > CREDIT_SEARCH_LIMITS.namesPerCreator ||
          entry.witness.qualifiers.length > CREDIT_SEARCH_LIMITS.qualifiersPerCredit) return { state: 'incomplete' };
      if (!validEntry(entry, workId)) return { state: 'unavailable' };
      if (!entry.namesComplete) return { state: 'incomplete' };
      if (statements.has(entry.witness.statementId)) return { state: 'unavailable' };
      statements.add(entry.witness.statementId);
      const seen = new Set<string>();
      for (const name of entry.names) {
        const identity = JSON.stringify(name);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const witness = structuredClone({ ...entry.witness, name });
        material += bytes(witness);
        if (material > CREDIT_SEARCH_LIMITS.documentBytes) return { state: 'incomplete' };
        names.push(witness);
      }
    }
    if (page.next === null) {
      if (!(await source.unchanged(workId, observation))) return { state: 'restart' };
      return { state: 'complete', workId, observation, names };
    }
    if (!bounded(page.next, 4096) || cursors.has(page.next)) return { state: 'unavailable' };
    cursors.add(page.next);
    after = page.next;
  }
  return { state: 'incomplete' };
}

/** The evidence must be one ACTUAL engine match, never the first displayed creator.
 * No phrase matching in JavaScript: the existing analyzer remains the matching authority. */
export async function currentCreditSearchMatch(
  source: CreditSearchSource | undefined,
  projection: CreditSearchProjection,
  matched: CreditSearchWitness,
): Promise<'current' | 'restart' | 'unavailable'> {
  if (!source || projection.state !== 'complete') return 'unavailable';
  if (!projection.names.some((name) => isDeepStrictEqual(name, matched))) return 'unavailable';
  // Own the engine evidence across both asynchronous native observations.
  const witness = structuredClone(matched);
  const { workId, observation } = projection;
  const current = await source.current(witness, observation);
  if (current === 'unavailable') return 'unavailable';
  if (!current || !(await source.unchanged(workId, observation))) return 'restart';
  return 'current';
}
