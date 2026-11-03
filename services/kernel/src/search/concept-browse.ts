/** A descendant predicate is tied to its property, scheme, and observed source cut. */
export type ConceptDescendantSelection = Readonly<{
  concept: string;
  property: string;
  scheme: string;
  includeChildren: true;
}>;

export type ConceptGraphBinding = Readonly<{
  release: string;
  graph: string;
  scheme: string;
}>;

export type ConceptBrowseState = Readonly<{
  version: 1;
  selection: ConceptDescendantSelection;
  binding: ConceptGraphBinding;
  discovered: readonly string[];
  frontier: readonly Readonly<{ parent: string; after: string | null }>[];
}>;

export type ConceptBrowsePage = Readonly<{
  binding: ConceptGraphBinding;
  /** Distinct child IDs in the native reader's full-key order. */
  children: readonly string[];
  /** Number of native relation rows examined by this indexed seek. */
  examined: number;
  hasMore: boolean;
}>;

export type ConceptBrowseObservation =
  | Readonly<{ status: 'current'; binding: ConceptGraphBinding }>
  | Readonly<{ status: 'preparing' | 'unavailable' | 'rejected' }>;

export type ConceptBrowseRead =
  | Readonly<{ status: 'current'; page: ConceptBrowsePage }>
  | Readonly<{ status: 'preparing' | 'unavailable' | 'rejected' }>;

/** The adapter must use current, scheme-scoped SKOS broader reads and full-key indexed seeks. */
export type ConceptBrowseSource = Readonly<{
  observe(): Promise<ConceptBrowseObservation>;
  children(
    input: Readonly<{
      binding: ConceptGraphBinding;
      parent: string;
      after: string | null;
      limit: number;
    }>,
  ): Promise<ConceptBrowseRead>;
}>;

export type ConceptBrowseLimits = Readonly<{
  pages: number;
  edges: number;
  pageSize: number;
}>;

export type ConceptBrowseResult =
  | Readonly<{ status: 'complete'; binding: ConceptGraphBinding; concepts: readonly string[] }>
  | Readonly<{ status: 'preparing'; state: ConceptBrowseState; pages: number; edges: number }>
  | Readonly<{ status: 'unavailable' | 'rejected' }>
  | Readonly<{ status: 'restart' }>;

function sameBinding(left: ConceptGraphBinding, right: ConceptGraphBinding): boolean {
  return left.release === right.release && left.graph === right.graph && left.scheme === right.scheme;
}

function validBinding(binding: ConceptGraphBinding): boolean {
  return Boolean(binding.release && binding.graph && binding.scheme);
}

function validLimits(limits: ConceptBrowseLimits): boolean {
  return (
    Number.isSafeInteger(limits.pages) &&
    limits.pages > 0 &&
    Number.isSafeInteger(limits.edges) &&
    limits.edges > 0 &&
    Number.isSafeInteger(limits.pageSize) &&
    limits.pageSize > 0 &&
    limits.pageSize <= limits.edges
  );
}

export function startConceptBrowse(
  selection: ConceptDescendantSelection,
  binding: ConceptGraphBinding,
): ConceptBrowseState | null {
  if (
    !selection.concept ||
    !selection.property ||
    !selection.scheme ||
    selection.includeChildren !== true ||
    !validBinding(binding) ||
    selection.scheme !== binding.scheme
  )
    return null;
  return {
    version: 1,
    selection,
    binding,
    discovered: [selection.concept],
    frontier: [{ parent: selection.concept, after: null }],
  };
}

/** Advance a bounded step. Incomplete or hidden source evidence never becomes an empty closure. */
export async function advanceConceptBrowse(
  source: ConceptBrowseSource,
  state: ConceptBrowseState,
  limits: ConceptBrowseLimits,
): Promise<ConceptBrowseResult> {
  if (!validLimits(limits) || state.version !== 1 || !validBinding(state.binding)) return { status: 'rejected' };
  const first = await source.observe();
  if (first.status !== 'current')
    return first.status === 'preparing' ? { status: 'preparing', state, pages: 0, edges: 0 } : { status: first.status };
  if (!sameBinding(first.binding, state.binding)) return { status: 'restart' };

  const discovered = new Set(state.discovered);
  const frontier = [...state.frontier];
  let pages = 0;
  let edges = 0;

  while (frontier.length && pages < limits.pages && edges < limits.edges) {
    const current = frontier.shift()!;
    const limit = Math.min(limits.pageSize, limits.edges - edges);
    const read = await source.children({
      binding: state.binding,
      parent: current.parent,
      after: current.after,
      limit,
    });
    if (read.status !== 'current') {
      return read.status === 'preparing'
        ? {
            status: 'preparing',
            state: { ...state, discovered: [...discovered], frontier: [current, ...frontier] },
            pages,
            edges,
          }
        : { status: read.status };
    }
    const page = read.page;
    if (
      !sameBinding(page.binding, state.binding) ||
      !Number.isSafeInteger(page.examined) ||
      page.examined < page.children.length ||
      page.examined > limit ||
      page.children.length > limit ||
      page.children.some((child, index) => !child || (index > 0 && page.children[index - 1]! >= child)) ||
      (current.after !== null && page.children.some((child) => child <= current.after!)) ||
      (page.hasMore && page.children.length === 0)
    )
      return { status: 'restart' };

    pages += 1;
    edges += page.examined;
    if (page.hasMore) {
      const after = page.children.at(-1)!;
      if (current.after !== null && after <= current.after) return { status: 'restart' };
      frontier.push({ parent: current.parent, after });
    }
    for (const child of page.children) {
      if (discovered.has(child)) continue;
      discovered.add(child);
      frontier.push({ parent: child, after: null });
    }
  }

  const nextState: ConceptBrowseState = { ...state, discovered: [...discovered], frontier };
  if (frontier.length) return { status: 'preparing', state: nextState, pages, edges };

  const final = await source.observe();
  if (final.status === 'preparing') return { status: 'preparing', state: nextState, pages, edges };
  if (final.status !== 'current') return { status: final.status };
  if (!sameBinding(final.binding, state.binding)) return { status: 'restart' };
  return {
    status: 'complete',
    binding: state.binding,
    concepts: [...discovered].filter((id) => id !== state.selection.concept).sort(),
  };
}
