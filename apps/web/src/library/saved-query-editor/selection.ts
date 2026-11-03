import { parseFilter, type FilterDocument } from '@rezics/filter';

const presence: FilterDocument = { owner: { presence: true } };

export type SavedQueryIssue = { key: string; reason: 'invalid' | 'unrepresentable' };
export type SavedQuerySelection =
  | { state: 'empty' }
  | { state: 'admitted'; filter: FilterDocument; sort: 'id' }
  | { state: 'invalid'; issues: SavedQueryIssue[] };

export type SavedQueryInput = {
  document?: FilterDocument;
  type?: string;
  search?: string | URLSearchParams;
  invalid?: boolean;
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
    return { state: 'admitted', filter: withPresence(parseFilter(combined)), sort: 'id' };
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

/** The selection lives only in a same-tab module handoff, never in the destination URL. */
export function savedQueryCreateHref(locale: string): string {
  return `/${locale}/library/rules/new`;
}
