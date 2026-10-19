import { WorkReadUnavailable } from '../work/read-session.ts';
import { checkedNativeIri } from '../semantic/schema.ts';
import { ASSOCIATION_COST, ASSOCIATION_QUERY, type AssociationResult, type AssociationSelection,
  type AssociationWitness, type AssociationWorkMatch } from './association-contract.ts';
import { associationMatchSelection, associationOrderKey, issueAssociationCursor, readAssociationCursor,
  AssociationCursorInvalid, type AssociationFrontier, type AssociationKey, type AssociationReadBasis, type AssociationSurface } from './association-cursor.ts';
import { matchesAssociation } from './association-match.ts';

/** The query composes existing owners through one request/session. Candidates
 * carry only ordered references. witness() must prove current disclosure,
 * adoption, exact coverage, compatible frames and evidence before returning a
 * complete witness; null means a withheld candidate. A matches frontier must
 * remain within its key's Work, including hidden-only windows. An unavailable
 * owner throws. It must never be represented by null or an empty window. */
export interface AssociationPageSource {
  candidates(after: AssociationFrontier | null, limit: number): Promise<{ items: AssociationKey[]; more: boolean }>;
  witness(key: AssociationKey): Promise<AssociationWitness | null>;
  fence(): Promise<void>;
}
function afterFrontier(key: AssociationKey, frontier: AssociationFrontier | null): boolean {
  return !frontier || (frontier.kind === 'work' ? key.work > frontier.work
    : (frontier.kind !== 'matches' || key.work === frontier.key.work)
      && associationOrderKey(key) > associationOrderKey(frontier.key));
}
function laterWorkPossible(selection: AssociationSelection, work: string): boolean {
  return selection.parameters.direction !== 'work-to-subject' || !selection.parameters.roots
    || selection.parameters.roots.some(root => root.kind === 'resource' && root.ref > work);
}

/** Bounded keyset projection, shared by the generic and dedicated surfaces.
 * A physical frontier survives hidden-only pages. Work projection skips an
 * emitted Work in its outer cursor and gives its unexhausted witness frontier
 * to a separately bound occurrence selection, so neither path loses matches. */
export async function readAssociationPage(source: AssociationPageSource, selection: AssociationSelection,
  basis: AssociationReadBasis, surface: AssociationSurface, token?: string): Promise<AssociationResult> {
  const cursor = readAssociationCursor(token, selection, basis, surface);
  const workProjection = selection.parameters.projection === 'work';
  if ((cursor.frontier?.kind === 'work' && !workProjection) || (cursor.frontier?.kind === 'matches' && workProjection)) {
    throw new AssociationCursorInvalid('Association frontier differs from its projection');
  }
  // At most 64 candidate hydrations, including withheld candidates. The 256
  // candidate ceiling is an upper bound, never a global population size.
  const window = await source.candidates(cursor.frontier, ASSOCIATION_COST.witnesses);
  if (window.items.length > ASSOCIATION_COST.witnesses || (!window.items.length && window.more)) {
    throw new WorkReadUnavailable('Association candidate owner returned an invalid window');
  }
  let previous = cursor.frontier;
  for (const key of window.items) {
    try { for (const value of [key.work, key.occurrence, key.subjectParticipation]) checkedNativeIri(value); }
    catch { throw new WorkReadUnavailable('Association candidate identity is unavailable'); }
    if (!afterFrontier(key, previous)) throw new WorkReadUnavailable('Association candidate order is unavailable');
    previous = { kind: cursor.frontier?.kind === 'matches' ? 'matches' : 'occurrence', key };
  }
  const occurrences: AssociationWitness[] = [], works: AssociationWorkMatch[] = [];
  let examined: AssociationKey | null = null, consumed = 0;
  let group: { work: string; items: AssociationWitness[]; after: AssociationKey } | null = null;
  const finishGroup = (exhausted: boolean) => {
    if (!group?.items.length) { group = null; return; }
    const nested = exhausted ? null : issueAssociationCursor(associationMatchSelection(selection, group.work), basis,
      surface, { kind: 'matches', key: group.after }, cursor.expiresAt);
    works.push({ work: group.work, matches: { items: group.items, complete: nested === null, nextCursor: nested } });
    group = null;
  };
  for (const key of window.items) {
    if (workProjection && group && group.work !== key.work) {
      finishGroup(true);
      if (works.length === selection.limit) break;
    }
    const witness = await source.witness(key);
    examined = key; consumed++;
    if (workProjection) {
      group ??= { work: key.work, items: [], after: key };
      group.after = key;
    }
    if (!witness) continue;
    if (associationOrderKey(witness) !== associationOrderKey(key) || witness.kind !== selection.parameters.kind) {
      throw new WorkReadUnavailable('Association witness differs from its exact candidate');
    }
    if (!matchesAssociation(selection, witness)) continue;
    if (workProjection) group!.items.push(witness);
    else {
      occurrences.push(witness);
      if (occurrences.length === selection.limit) break;
    }
  }
  const remaining = consumed < window.items.length || window.more;
  finishGroup(!remaining);
  let frontier: AssociationFrontier | null = remaining && examined
    ? { kind: cursor.frontier?.kind === 'matches' ? 'matches' : 'occurrence', key: examined } : null;
  if (frontier && workProjection && works.at(-1)?.work === examined!.work) {
    frontier = laterWorkPossible(selection, examined!.work) ? { kind: 'work', work: examined!.work } : null;
  }
  await source.fence();
  const nextCursor = frontier ? issueAssociationCursor(selection, basis, surface, frontier, cursor.expiresAt) : null;
  const items = workProjection ? works : occurrences;
  return { profile: 'template-result-v1', query: ASSOCIATION_QUERY, revision: 1, ...basis.snapshot,
    items, nextCursor, complete: nextCursor === null, count: { value: items.length, kind: 'exact-page', total: null } };
}
