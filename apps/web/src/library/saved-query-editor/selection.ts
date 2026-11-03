import { parseFilter, type FilterDocument } from '@rezics/filter';

const presence: FilterDocument = { owner: { presence: true } };
const filterBound = 8192;

export type SavedQueryIssue = { key: string; reason: 'invalid' | 'unrepresentable' };
export type SavedQuerySelection =
  | { state: 'empty' }
  | { state: 'admitted'; filter: FilterDocument }
  | { state: 'invalid'; issues: SavedQueryIssue[] };
export type SavedQueryInput = {
  filter?: string;
  type?: string;
  state?: string;
  label?: string;
  from?: string;
};

function hasPresence(filter: FilterDocument): boolean {
  if ('owner' in filter && 'presence' in filter.owner) return true;
  return 'and' in filter && filter.and.some(hasPresence);
}

function withPresence(filter: FilterDocument): FilterDocument {
  return hasPresence(filter) ? filter : { and: [presence, filter] };
}

function take(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  return value && value.length <= filterBound ? value : undefined;
}

/** Relative same-origin path only; this draft never becomes a public address. */
export function localPath(value: string | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('\0'))
    return null;
  try {
    const url = new URL(value, 'https://rezics.local');
    return url.origin === 'https://rezics.local' ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

export function readSavedQuerySearch(search: string | URLSearchParams): SavedQueryInput {
  const params =
    typeof search === 'string'
      ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
      : search;
  const filter = take(params, 'filter');
  const type = take(params, 'type');
  const state = take(params, 'state');
  const label = take(params, 'label');
  const from = take(params, 'from');
  return {
    ...(filter ? { filter } : {}),
    ...(type ? { type } : {}),
    ...(state ? { state } : {}),
    ...(label ? { label } : {}),
    ...(from ? { from } : {}),
  };
}

function parsed(value: unknown, key: string, issues: SavedQueryIssue[]): FilterDocument | undefined {
  try {
    return parseFilter(value);
  } catch {
    issues.push({ key, reason: 'invalid' });
    return undefined;
  }
}

/**
 * Carry only the shared grammar. A Library state ID has no profile or state set, so it cannot
 * become an owner.state leaf.
 */
export function admitSavedQueryInput(input: SavedQueryInput): SavedQuerySelection {
  const issues: SavedQueryIssue[] = [];
  const clauses: FilterDocument[] = [];
  if (input.state) issues.push({ key: 'state', reason: 'unrepresentable' });
  if (input.filter) {
    let raw: unknown;
    try {
      raw = JSON.parse(input.filter);
    } catch {
      issues.push({ key: 'filter', reason: 'invalid' });
      raw = undefined;
    }
    if (raw !== undefined) {
      const filter = parsed(raw, 'filter', issues);
      if (filter) clauses.push(filter);
    }
  }
  if (input.type) {
    const type = parsed({ type: { in: [input.type] } }, 'type', issues);
    if (type) clauses.push(type);
  }
  if (input.label) {
    const label = parsed({ owner: { label: { id: input.label } } }, 'label', issues);
    if (label) clauses.push(label);
  }
  if (issues.length) return { state: 'invalid', issues };
  if (!clauses.length) return { state: 'empty' };
  const combined = clauses.length === 1 ? clauses[0]! : { and: clauses };
  const filter = parsed(combined, 'filter', issues);
  return filter && !issues.length ? { state: 'admitted', filter: withPresence(filter) } : { state: 'invalid', issues };
}

/** Only an admitted create selection seeds the private rule form. */
export function savedQuerySeed(
  collectionId: string | null,
  selection: SavedQuerySelection,
): FilterDocument | undefined {
  return collectionId === null && selection.state === 'admitted' ? selection.filter : undefined;
}

export function savedQueryCreateHref(
  locale: string,
  input: { document?: FilterDocument; type?: string; state?: string; label?: string; from?: string },
): string {
  const params = new URLSearchParams();
  if (input.document) params.set('filter', JSON.stringify(input.document));
  if (input.type) params.set('type', input.type);
  if (input.state) params.set('state', input.state);
  if (input.label) params.set('label', input.label);
  const from = localPath(input.from);
  if (from) params.set('from', from);
  const query = params.toString();
  return `/${locale}/library/rules/new${query ? `?${query}` : ''}`;
}
