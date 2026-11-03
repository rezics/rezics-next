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
export type ConceptBrowseFrontier = Readonly<{ parent: string; after: string | null }>;
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
 * Operations are fenced by immutable definition and revision. create seeds the root; read retrieves
 * at most one frontier row. advance atomically advances that row, inserts distinct membership keys
 * and queues only newly inserted keys using indexed deduplication. seal requires an empty frontier.
 * Losing a CAS returns null. Retirement/expiry of the owning plan disables every operation.
 * contains returns a Boolean only for a sealed generation; root membership is included.
 */
export type ConceptBrowseStore = Readonly<{
  create(selection: ConceptDescendantSelection, binding: ConceptBrowseBinding): Promise<ConceptBrowseLocator>;
  read(
    locator: ConceptBrowseLocator,
  ): Promise<
    Readonly<{ status: 'building'; next: ConceptBrowseFrontier | null }> | Readonly<{ status: 'complete' | 'retired' }>
  >;
  advance(
    locator: ConceptBrowseLocator,
    expected: ConceptBrowseFrontier,
    delta: Readonly<{ children: readonly string[]; after: string | null; exhausted: boolean }>,
  ): Promise<ConceptBrowseLocator | null>;
  seal(locator: ConceptBrowseLocator): Promise<ConceptBrowseLocator | null>;
  retire(locator: ConceptBrowseLocator): Promise<void>;
  contains(locator: ConceptBrowseLocator, concept: string): Promise<boolean | null>;
}>;
/** Absolute working-set limits; total retained graph size is never a request-sized array. */
export const CONCEPT_BROWSE_LIMITS = Object.freeze({ pages: 32, edges: 4096, pageSize: 256, keyBytes: 1024 });
export type ConceptBrowseLimits = Readonly<{ pages: number; edges: number; pageSize: number }>;
export type ConceptBrowseResult =
  | Readonly<{ status: 'complete' | 'preparing'; state: ConceptBrowseState; pages: number; edges: number }>
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
    selection: Object.freeze({ ...state.selection }),
    binding: Object.freeze({ ...state.binding }),
    retained: Object.freeze({ ...state.retained }),
  });
}
export async function startConceptBrowse(
  selection: ConceptDescendantSelection,
  binding: ConceptBrowseBinding,
  store: ConceptBrowseStore,
): Promise<ConceptBrowseState | null> {
  if (!validBinding(binding) || !validSelection(selection, binding)) return null;
  // Copy before awaiting persistence; caller mutation cannot change the retained definition.
  const selected = Object.freeze({ ...selection });
  const observed = Object.freeze({ ...binding });
  const retained = await store.create(selected, observed);
  return validLocator(retained) ? freezeState({ version: 2, selection: selected, binding: observed, retained }) : null;
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
  let state = freezeState(input);
  let pages = 0,
    edges = 0;
  async function retire(status: 'restart' | 'unavailable' | 'rejected'): Promise<ConceptBrowseResult> {
    await store.retire(state.retained);
    return { status };
  }
  const first = await source.observe();
  if (first.status !== 'current')
    return first.status === 'preparing' ? { status: 'preparing', state, pages, edges } : retire(first.status);
  if (!sameBinding(first.binding, state.binding)) return retire('restart');

  let retained = await store.read(state.retained);
  while (retained.status === 'building' && retained.next && pages < limits.pages && edges < limits.edges) {
    const current = Object.freeze({ ...retained.next });
    if (!key(current.parent) || (current.after !== null && !key(current.after))) return retire('restart');
    const limit = Math.min(limits.pageSize, limits.edges - edges);
    pages++;
    const read = await source.children({ ...current, binding: state.binding, limit });
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
    const next = await store.advance(state.retained, current, {
      children: [...new Set(page.children)],
      after: page.after,
      exhausted: !page.hasMore,
    });
    if (!next || !validLocator(next)) return retire('restart');
    state = freezeState({ ...state, retained: next });
    retained = await store.read(state.retained);
  }
  if (retained.status === 'retired') return { status: 'restart' };
  const final = await source.observe();
  if (final.status !== 'current')
    return final.status === 'preparing' ? { status: 'preparing', state, pages, edges } : retire(final.status);
  if (!sameBinding(final.binding, state.binding)) return retire('restart');
  if (retained.status === 'building' && retained.next) return { status: 'preparing', state, pages, edges };
  if (retained.status !== 'complete') {
    const sealed = await store.seal(state.retained);
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
  if (
    state.version !== 2 ||
    !validBinding(state.binding) ||
    !validSelection(state.selection, state.binding) ||
    !validLocator(state.retained) ||
    !key(concept)
  )
    return 'not_proven';
  const snapshot = freezeState(state);
  const first = await source.observe();
  if (first.status !== 'current') {
    if (first.status !== 'preparing') await store.retire(snapshot.retained);
    return 'not_proven';
  }
  if (!sameBinding(first.binding, snapshot.binding)) {
    await store.retire(snapshot.retained);
    return 'not_proven';
  }
  const member = await store.contains(snapshot.retained, concept);
  if (member === null) return 'not_proven';
  const final = await source.observe();
  if (final.status !== 'current' || !sameBinding(final.binding, snapshot.binding)) {
    if (final.status !== 'preparing') await store.retire(snapshot.retained);
    return 'not_proven';
  }
  return member;
}
