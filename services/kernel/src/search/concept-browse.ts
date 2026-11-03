import { currentConceptStatementsMatch } from './current-filter-plan.ts';
import type { RelationFacetMatch } from './source.ts';

/** A descendant predicate is tied to its property, scheme, and observed source cut. */
export type ConceptDescendantSelection = Readonly<{
  concept: string;
  property: string;
  scheme: string;
  includeChildren: true;
}>;
/** Every field participates in currentness, including for exclusion. */
export type ConceptBrowseBinding = Readonly<{
  release: string;
  graph: string;
  scheme: string;
  membership: string;
  principal: string;
  request: string;
}>;
/** An internal locator in the existing retained-plan lifecycle, never a public cursor. */
export type ConceptBrowseLocator = Readonly<{ id: string; revision: string }>;
export type ConceptBrowseState = Readonly<{
  version: 2;
  selection: ConceptDescendantSelection;
  binding: ConceptBrowseBinding;
  retained: ConceptBrowseLocator;
}>;
export type ConceptBrowseFrontier = Readonly<{
  parent: string;
  after: string | null;
}>;
export type ConceptBrowsePage = Readonly<{
  binding: ConceptBrowseBinding;
  children: readonly string[];
  /** Native rows examined, including duplicates and rows irrelevant to this scheme. */
  examined: number;
  /** The sortable full native edge key, independent of the disclosed child IDs. */
  after: string | null;
  hasMore: boolean;
}>;
export type ConceptBrowseObservation =
  | Readonly<{ status: 'current'; binding: ConceptBrowseBinding }>
  | Readonly<{ status: 'preparing' | 'unavailable' | 'rejected' }>;
export type ConceptBrowseRead =
  | Readonly<{ status: 'current'; page: ConceptBrowsePage }>
  | Readonly<{ status: 'preparing' | 'unavailable' | 'rejected' }>;
/** Current, scheme-scoped SKOS broader seeks. Withheld or incomplete graph evidence is unavailable,
 * never a successful empty page. Full-key cursors advance through duplicate/irrelevant rows.
 */
export type ConceptBrowseSource = Readonly<{
  observe(): Promise<ConceptBrowseObservation>;
  children(
    input: ConceptBrowseFrontier & Readonly<{ binding: ConceptBrowseBinding; limit: number }>,
  ): Promise<ConceptBrowseRead>;
}>;
/** Derived storage beneath the existing retained-plan worker, not another capture or scheduler.
 * Operations compare the supplied selection/binding to the retained definition and revision.
 * create seeds the root; read retrieves at most one frontier row. advance atomically advances that row, inserts distinct membership keys
 * and queues only newly inserted keys using indexed deduplication. seal requires an empty frontier.
 * Losing a CAS returns null. Retirement/expiry of the owning plan disables every operation.
 * contains returns a Boolean only for a sealed generation; root membership is included.
 */
export type ConceptBrowseStore = Readonly<{
  create(selection: ConceptDescendantSelection, binding: ConceptBrowseBinding): Promise<ConceptBrowseLocator>;
  read(
    state: ConceptBrowseState,
  ): Promise<
    Readonly<{ status: 'building'; next: ConceptBrowseFrontier | null }> | Readonly<{ status: 'complete' | 'retired' }>
  >;
  advance(
    state: ConceptBrowseState,
    expected: ConceptBrowseFrontier,
    delta: Readonly<{
      children: readonly string[];
      after: string | null;
      exhausted: boolean;
    }>,
  ): Promise<ConceptBrowseLocator | null>;
  seal(state: ConceptBrowseState): Promise<ConceptBrowseLocator | null>;
  retire(state: ConceptBrowseState): Promise<void>;
  contains(state: ConceptBrowseState, concept: string): Promise<boolean | null>;
}>;
/** Absolute working-set limits; total retained graph size is never a request-sized array. */
export const CONCEPT_BROWSE_LIMITS = Object.freeze({
  pages: 32,
  edges: 4096,
  pageSize: 256,
  keyBytes: 1024,
});
/** Fixed per-dispatch worker allowance. Closure size is retained across dispatches. */
export const CONCEPT_BROWSE_WORKER_LIMITS = Object.freeze({ pages: 4, edges: 256, pageSize: 64 });
export type ConceptBrowseLimits = Readonly<{
  pages: number;
  edges: number;
  pageSize: number;
}>;
export type ConceptBrowseResult =
  | Readonly<{
      status: 'complete' | 'preparing';
      state: ConceptBrowseState;
      pages: number;
      edges: number;
    }>
  | Readonly<{ status: 'unavailable' | 'rejected' | 'restart' }>;

const encoder = new TextEncoder();
function key(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CONCEPT_BROWSE_LIMITS.keyBytes &&
    encoder.encode(value).byteLength <= CONCEPT_BROWSE_LIMITS.keyBytes
  );
}
function sameBinding(left: ConceptBrowseBinding, right: ConceptBrowseBinding): boolean {
  return (
    left.release === right.release &&
    left.graph === right.graph &&
    left.scheme === right.scheme &&
    left.membership === right.membership &&
    left.principal === right.principal &&
    left.request === right.request
  );
}
function validBinding(binding: ConceptBrowseBinding): boolean {
  return [binding.release, binding.graph, binding.scheme, binding.membership, binding.principal, binding.request].every(
    key,
  );
}
function validSelection(selection: ConceptDescendantSelection, binding: ConceptBrowseBinding): boolean {
  return (
    key(selection.concept) &&
    key(selection.property) &&
    key(selection.scheme) &&
    selection.includeChildren === true &&
    selection.scheme === binding.scheme
  );
}
function validLocator(locator: ConceptBrowseLocator): boolean {
  return key(locator.id) && /^[1-9][0-9]{0,19}$/.test(locator.revision);
}
function validLimits(limits: ConceptBrowseLimits): boolean {
  return (
    Number.isSafeInteger(limits.pages) &&
    limits.pages > 0 &&
    limits.pages <= CONCEPT_BROWSE_LIMITS.pages &&
    Number.isSafeInteger(limits.edges) &&
    limits.edges > 0 &&
    limits.edges <= CONCEPT_BROWSE_LIMITS.edges &&
    Number.isSafeInteger(limits.pageSize) &&
    limits.pageSize > 0 &&
    limits.pageSize <= limits.edges &&
    limits.pageSize <= CONCEPT_BROWSE_LIMITS.pageSize
  );
}
function freezeState(state: ConceptBrowseState): ConceptBrowseState {
  return Object.freeze({
    version: 2 as const,
    selection: Object.freeze({
      concept: state.selection.concept,
      property: state.selection.property,
      scheme: state.selection.scheme,
      includeChildren: true as const,
    }),
    binding: Object.freeze({
      release: state.binding.release,
      graph: state.binding.graph,
      scheme: state.binding.scheme,
      membership: state.binding.membership,
      principal: state.binding.principal,
      request: state.binding.request,
    }),
    retained: Object.freeze({
      id: state.retained.id,
      revision: state.retained.revision,
    }),
  });
}
export async function startConceptBrowse(
  selection: ConceptDescendantSelection,
  binding: ConceptBrowseBinding,
  store: ConceptBrowseStore,
): Promise<ConceptBrowseState | null> {
  if (!validBinding(binding) || !validSelection(selection, binding)) return null;
  // Copy before awaiting persistence; caller mutation cannot change the retained definition.
  const definition = freezeState({
    version: 2,
    selection,
    binding,
    retained: { id: '', revision: '' },
  });
  const retained = await store.create(definition.selection, definition.binding);
  return validLocator(retained) ? freezeState({ ...definition, retained }) : null;
}
/** One finite worker step. No discovered/frontier population is copied or returned. */
export async function advanceConceptBrowse(
  source: ConceptBrowseSource,
  store: ConceptBrowseStore,
  input: ConceptBrowseState,
  limits: ConceptBrowseLimits,
): Promise<ConceptBrowseResult> {
  if (
    !validLimits(limits) ||
    input.version !== 2 ||
    !validBinding(input.binding) ||
    !validSelection(input.selection, input.binding) ||
    !validLocator(input.retained)
  )
    return { status: 'rejected' };
  // Own the admitted allowance before asynchronous source or retained-store operations.
  limits = Object.freeze({
    pages: limits.pages,
    edges: limits.edges,
    pageSize: limits.pageSize,
  });
  let state = freezeState(input);
  let pages = 0,
    edges = 0;
  async function retire(status: 'restart' | 'unavailable' | 'rejected'): Promise<ConceptBrowseResult> {
    await store.retire(state);
    return { status };
  }
  const first = await source.observe();
  if (first.status !== 'current')
    return first.status === 'preparing' ? { status: 'preparing', state, pages, edges } : retire(first.status);
  if (!sameBinding(first.binding, state.binding)) return retire('restart');

  let retained = await store.read(state);
  while (retained.status === 'building' && retained.next && pages < limits.pages && edges < limits.edges) {
    const current = Object.freeze({ ...retained.next });
    if (!key(current.parent) || (current.after !== null && !key(current.after))) return retire('restart');
    const limit = Math.min(limits.pageSize, limits.edges - edges);
    pages++;
    const read = await source.children({
      ...current,
      binding: state.binding,
      limit,
    });
    if (read.status !== 'current') {
      if (read.status !== 'preparing') return retire(read.status);
      break;
    }
    const page = read.page;
    if (
      !sameBinding(page.binding, state.binding) ||
      !Number.isSafeInteger(page.examined) ||
      page.examined < page.children.length ||
      page.examined > limit ||
      page.children.length > limit ||
      page.children.some((child) => !key(child)) ||
      (page.after !== null && !key(page.after)) ||
      (page.examined > 0 && (page.after === null || (current.after !== null && page.after <= current.after))) ||
      (page.examined === 0 && (page.hasMore || page.after !== current.after))
    )
      return retire('restart');
    edges += page.examined;
    const next = await store.advance(state, current, {
      children: [...new Set(page.children)],
      after: page.after,
      exhausted: !page.hasMore,
    });
    if (!next || !validLocator(next)) return retire('restart');
    state = freezeState({ ...state, retained: next });
    retained = await store.read(state);
  }
  if (retained.status === 'retired') return { status: 'restart' };
  const final = await source.observe();
  if (final.status !== 'current')
    return final.status === 'preparing' ? { status: 'preparing', state, pages, edges } : retire(final.status);
  if (!sameBinding(final.binding, state.binding)) return retire('restart');
  if (retained.status === 'building' && retained.next) return { status: 'preparing', state, pages, edges };
  if (retained.status !== 'complete') {
    const sealed = await store.seal(state);
    if (!sealed || !validLocator(sealed)) return retire('restart');
    state = freezeState({ ...state, retained: sealed });
  }
  return { status: 'complete', state, pages, edges };
}
/** Membership is not disclosure of a classification statement. The shared matcher must also prove
 * the same-statement witness. Unknown, unsealed, retired or changed evidence stays unknown under NOT.
 */
export async function currentConceptMembership(
  source: ConceptBrowseSource,
  store: ConceptBrowseStore,
  state: ConceptBrowseState,
  concept: string,
): Promise<boolean | 'not_proven'> {
  return (await currentConceptMemberships(source, store, state, [concept]))[0]!;
}

/** One bounded page of point probes shares a cut, independently of total closure size.
 * The source owns observation costs; the retained store reserves each distinct full-key probe.
 * No provisional verdict escapes when any probe or the final revision check loses the cut.
 */
export async function currentConceptMemberships(
  source: ConceptBrowseSource,
  store: ConceptBrowseStore,
  state: ConceptBrowseState,
  concepts: readonly string[],
): Promise<RelationFacetMatch[]> {
  if (!Array.isArray(concepts) || concepts.length > CONCEPT_BROWSE_LIMITS.pageSize)
    throw new RangeError('Invalid concept membership page');
  const unknown = (): RelationFacetMatch[] => Array.from({ length: concepts.length }, () => 'not_proven');
  if (
    state.version !== 2 ||
    !validBinding(state.binding) ||
    !validSelection(state.selection, state.binding) ||
    !validLocator(state.retained) ||
    Array.from(concepts).some((concept) => !key(concept))
  )
    return unknown();
  if (!concepts.length) return [];
  // Own both the requested keys and the entire retained definition before the first await.
  const requested = [...concepts];
  const missing = requested.map(() => 'not_proven' as const);
  const snapshot = freezeState(state);
  const first = await source.observe();
  if (first.status !== 'current') {
    if (first.status !== 'preparing') await store.retire(snapshot);
    return missing;
  }
  if (!sameBinding(first.binding, snapshot.binding)) {
    await store.retire(snapshot);
    return missing;
  }
  const members = new Map<string, boolean>();
  for (const concept of requested) {
    if (members.has(concept)) continue;
    const member = await store.contains(snapshot, concept);
    if (typeof member !== 'boolean') return missing;
    members.set(concept, member);
  }
  const final = await source.observe();
  if (final.status !== 'current' || !sameBinding(final.binding, snapshot.binding)) {
    if (final.status !== 'preparing') await store.retire(snapshot);
    return missing;
  }
  const retained = await store.read(snapshot);
  return retained.status === 'complete' ? requested.map((concept) => members.get(concept)!) : missing;
}

/** Native evidence about ONE classified statement. The owner must prove the property and value,
 * disclosure and every admitted qualifier (including the spoiler threshold) on that same statement.
 * A witness is request-local evidence, never a retained permission or a completeness certificate.
 */
export type ConceptStatementWitness = Readonly<{
  property: string;
  concept: string;
  witness: RelationFacetMatch;
}>;

/** Compose native classified-statement evidence with retained exact/descendant membership.
 * `complete` may be true only from the owner's current absence proof for the entire statement
 * predicate, never from a LIMIT, an exhausted sample or an empty witness page. The enclosing native
 * caller still revalidates the statement evidence before publishing a useful page.
 */
export async function matchCurrentConceptStatements(
  source: ConceptBrowseSource,
  store: ConceptBrowseStore,
  state: ConceptBrowseState,
  input: Readonly<{
    selection: Readonly<{
      property: string;
      concept: string;
      scheme: string;
      includeChildren?: boolean;
    }>;
    statements: readonly ConceptStatementWitness[];
    complete: boolean;
  }>,
): Promise<RelationFacetMatch> {
  if (!Array.isArray(input.statements) || input.statements.length > CONCEPT_BROWSE_LIMITS.pageSize)
    throw new RangeError('Invalid concept statement page');
  const selection = { ...input.selection };
  if (
    selection.property !== state.selection.property ||
    selection.concept !== state.selection.concept ||
    selection.scheme !== state.selection.scheme ||
    (selection.includeChildren !== undefined && typeof selection.includeChildren !== 'boolean') ||
    typeof input.complete !== 'boolean'
  )
    return 'not_proven';
  const complete = input.complete;
  const statements: ConceptStatementWitness[] = [];
  for (const statement of input.statements) {
    if (
      !statement ||
      !key(statement.property) ||
      !key(statement.concept) ||
      ![true, false, 'not_proven'].includes(statement.witness)
    )
      return 'not_proven';
    if (
      statement.property === selection.property &&
      (selection.includeChildren || statement.concept === selection.concept)
    )
      statements.push({ ...statement });
  }
  // An empty native page still checks the retained cut before absence can participate in NOT.
  const members = await currentConceptMemberships(
    source,
    store,
    state,
    statements.length ? statements.map((statement) => statement.concept) : [selection.concept],
  );
  // Losing the retained cut invalidates the entire result, including an otherwise false witness.
  if (members.includes('not_proven')) return 'not_proven';
  if (!statements.length && members[0] !== true) return 'not_proven';
  return currentConceptStatementsMatch(
    statements.map((statement, index) => ({
      membership: members[index]!,
      witness: statement.witness,
    })),
    complete,
  );
}
