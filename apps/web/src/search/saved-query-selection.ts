import { FilterError, parseFilter, type FilterDocument } from '@rezics/filter';
import { searchFilterWithScope } from './advanced-scope';
import type { SearchLoaderDeps } from './search-params';

const presence: FilterDocument = { owner: { presence: true } };

/** Catalogue Search and owner Library pages share this Source discriminator. */
export type SavedQuerySource = Readonly<{ kind: 'owner' | 'catalogue' }>;

export type SavedQueryIssue = { key: string; reason: 'invalid' | 'unrepresentable' };
export type SavedQuerySelection =
  | { state: 'empty' }
  | { state: 'admitted'; filter: FilterDocument; sort: 'id'; source: SavedQuerySource }
  | { state: 'invalid'; issues: SavedQueryIssue[] };

export type SavedQueryInput = {
  document?: FilterDocument;
  type?: string;
  search?: string | URLSearchParams;
  invalid?: boolean;
  source?: SavedQuerySource;
};

/** One-use, in-memory handoff. It has no server or browser-storage instance. */
export type SavedQueryHandoff = {
  viewerId: string;
  filter: FilterDocument;
  sort: 'id';
  source: SavedQuerySource;
};

function hasPresence(filter: FilterDocument): boolean {
  if ('owner' in filter && 'presence' in filter.owner) return true;
  return 'and' in filter && filter.and.some(hasPresence);
}

function withPresence(filter: FilterDocument): FilterDocument {
  return hasPresence(filter) ? filter : { and: [presence, filter] };
}

function searchParams(search: string | URLSearchParams | undefined): URLSearchParams {
  if (search instanceof URLSearchParams) return new URLSearchParams(search);
  return new URLSearchParams((search ?? '').replace(/^\?/, ''));
}

export function hasSavedQueryInput(input: Pick<SavedQueryInput, 'document' | 'search' | 'invalid'>): boolean {
  if (input.document || input.invalid) return true;
  const params = searchParams(input.search);
  return [...params.keys()].some(
    (key) => !['cursor', 'layout', 'view', 'size', 'columns'].includes(key) && !key.startsWith('l.'),
  );
}

function unsupportedSearch(params: URLSearchParams, type: string | undefined, issues: SavedQueryIssue[]) {
  const types = params.getAll('type');
  if (types.length && (types.length !== 1 || types[0] !== type))
    issues.push({ key: 'type', reason: 'unrepresentable' });

  const sorts = params.getAll('sort');
  if (sorts.length && (sorts.length !== 1 || sorts[0] !== 'id'))
    issues.push({ key: 'sort', reason: 'unrepresentable' });

  const ignored = new Set(['type', 'sort', 'cursor', 'layout', 'view', 'size', 'columns']);
  const keys = new Set([...params.keys()]);
  for (const key of keys) {
    if (ignored.has(key) || /^[frl]\./.test(key)) continue;
    issues.push({ key, reason: 'unrepresentable' });
  }
}

/** Admit the exact Collection filter document, with its displayed type and the rule API's id order. */
export function admitSavedQuerySelection(input: SavedQueryInput): SavedQuerySelection {
  const issues: SavedQueryIssue[] = [];
  if (input.invalid) issues.push({ key: 'filter', reason: 'invalid' });
  unsupportedSearch(searchParams(input.search), input.type, issues);

  const clauses: FilterDocument[] = [];
  if (input.type) {
    try {
      clauses.push(parseFilter({ type: { in: [input.type] } }));
    } catch {
      issues.push({ key: 'type', reason: 'invalid' });
    }
  }
  if (input.document) {
    try {
      clauses.push(parseFilter(input.document));
    } catch {
      issues.push({ key: 'filter', reason: 'invalid' });
    }
  }
  if (issues.length) return { state: 'invalid', issues };
  if (!clauses.length) return { state: 'empty' };

  const combined = clauses.length === 1 ? clauses[0]! : { and: clauses };
  try {
    const source = input.source ?? { kind: 'owner' as const };
    if (source.kind !== 'owner' && source.kind !== 'catalogue')
      return { state: 'invalid', issues: [{ key: 'source', reason: 'invalid' }] };
    const filter = parseFilter(combined);
    return {
      state: 'admitted',
      filter: source.kind === 'owner' ? withPresence(filter) : filter,
      sort: 'id',
      source,
    };
  } catch {
    return { state: 'invalid', issues: [{ key: 'filter', reason: 'invalid' }] };
  }
}

/** Only a create selection can seed the private rule form. */
export function savedQuerySeed(
  collectionId: string | null,
  selection: SavedQuerySelection,
): FilterDocument | undefined {
  return collectionId === null && selection.state === 'admitted' ? selection.filter : undefined;
}

export function savedQuerySourceSeed(
  collectionId: string | null,
  selection: SavedQuerySelection,
): SavedQuerySource | undefined {
  return collectionId === null && selection.state === 'admitted' ? selection.source : undefined;
}

/** The selection lives only in a same-tab module handoff, never in the destination URL. */
export function savedQueryCreateHref(locale: string): string {
  return `/${locale}/library/rules/new`;
}

function handoffSource(value: SavedQueryHandoff['source']): SavedQuerySource | null {
  if (value.kind === 'owner' || value.kind === 'catalogue') return value;
  return null;
}

/** A one-use, in-memory handoff. It has no server or browser-storage instance. */
export function createSavedQueryHandoffStore() {
  let pending: SavedQueryHandoff | null = null;
  return {
    write(value: SavedQueryHandoff): boolean {
      const source = handoffSource(value.source);
      if (!value.viewerId || value.sort !== 'id' || !source) return false;
      try {
        pending = {
          viewerId: value.viewerId,
          filter: parseFilter(value.filter),
          sort: 'id',
          source,
        };
        return true;
      } catch {
        pending = null;
        return false;
      }
    },
    take(viewerId: string | null): SavedQueryHandoff | null {
      const value = pending;
      pending = null;
      return value && viewerId && value.viewerId === viewerId ? value : null;
    },
    clear() {
      pending = null;
    },
  };
}

const browserHandoff = typeof window === 'undefined' ? null : createSavedQueryHandoffStore();

export function writeSavedQueryHandoff(value: SavedQueryHandoff): boolean {
  return browserHandoff?.write(value) ?? false;
}

/** Consume even on a viewer mismatch so a replacement session can never inherit the query. */
export function takeSavedQueryHandoff(viewerId: string | null): SavedQueryHandoff | null {
  return browserHandoff?.take(viewerId) ?? null;
}

/** Save only a predicate that the dynamic Collection rule can represent without changing Search meaning. */
export function searchSavedQuerySelection(state: SearchLoaderDeps | undefined): SavedQuerySelection {
  if (!state) return { state: 'empty' };
  if (
    state.invalidInput ||
    state.query.trim() ||
    state.sort === 'rating' ||
    state.ratingPopulation ||
    state.resourceScope
  )
    return { state: 'invalid', issues: [{ key: 'search', reason: 'unrepresentable' }] };

  const clauses: unknown[] = [];
  try {
    if (state.condition) clauses.push(parseFilter(state.condition));
    const filter = searchFilterWithScope(state.filter, state.resourceScope);
    if (filter) clauses.push(parseFilter(JSON.parse(filter)));
    if (state.type) clauses.push(parseFilter({ type: { in: [state.type] } }));
    for (const [property, values] of Object.entries(state.facets)) {
      if (!values.length) continue;
      clauses.push(
        parseFilter(property === 'type' ? { type: { in: values } } : { statement: { property, in: values } }),
      );
    }
    for (const [property, range] of Object.entries(state.ranges ?? {}))
      clauses.push(parseFilter({ statement: { property, range } }));
    if (state.kinds?.length) clauses.push(parseFilter({ kind: { in: state.kinds } }));
    if (!clauses.length) return { state: 'empty' };
    const document = clauses.length === 1 ? clauses[0]! : { and: clauses };
    return admitSavedQuerySelection({
      document: parseFilter(document),
      source: { kind: 'catalogue' },
    });
  } catch (error) {
    if (error instanceof FilterError || error instanceof SyntaxError)
      return { state: 'invalid', issues: [{ key: 'filter', reason: 'invalid' }] };
    throw error;
  }
}
