import type { DirectoryColumn, DirectoryParams } from '../api/types.ts';
import { parseQuery } from './query.ts';

// `/admin/users?q&sort&dir&cursor`: all directory state lives in the URL, so
// every view is a link. Pure functions shared by the page, its components and tests.

export type SortKey = NonNullable<DirectoryParams['sort']>;
export type Direction = NonNullable<DirectoryParams['direction']>;
export interface DirectoryState { text: string; sort: SortKey; direction: Direction; cursor: string | null }

export const columnOrder: readonly DirectoryColumn[] = ['name', 'email', 'status', 'role', 'verified', 'twoFactor', 'created',
  'lastSignIn'];
export const defaultColumns: readonly DirectoryColumn[] = ['name', 'email', 'status', 'role', 'created', 'lastSignIn'];
/** Columns the service can sort by, and the parameter it takes. */
export const sortable: Partial<Record<DirectoryColumn, SortKey>> = { name: 'name', email: 'email', created: 'createdAt' };
const pageSize = 25;

const sorts: readonly SortKey[] = ['createdAt', 'email', 'name'];
const urlSort: Record<SortKey, string> = { createdAt: 'created', email: 'email', name: 'name' };

type Search = Record<string, string | string[] | undefined> | URLSearchParams;
const single = (search: Search, key: string) => {
  const value = search instanceof URLSearchParams ? search.get(key) : search[key];
  return (Array.isArray(value) ? value[0] : value) ?? undefined;
};

export function readState(search: Search): DirectoryState {
  const sortName = single(search, 'sort');
  const sort = sorts.find(key => urlSort[key] === sortName) ?? 'createdAt';
  const dir = single(search, 'dir');
  return { text: (single(search, 'q') ?? '').slice(0, 400), sort,
    direction: dir === 'asc' || dir === 'desc' ? dir : sort === 'createdAt' ? 'desc' : 'asc', cursor: single(search, 'cursor') ?? null };
}

export function stateHref(state: DirectoryState): string {
  const params = new URLSearchParams();
  if (state.text.trim()) params.set('q', state.text.trim());
  if (state.sort !== 'createdAt') params.set('sort', urlSort[state.sort]);
  if (state.direction !== (state.sort === 'createdAt' ? 'desc' : 'asc')) params.set('dir', state.direction);
  if (state.cursor) params.set('cursor', state.cursor);
  const query = params.toString();
  return `/admin/users${query ? `?${query}` : ''}`;
}

export function directoryParams(state: DirectoryState): DirectoryParams {
  return { ...parseQuery(state.text).filters, sort: state.sort, direction: state.direction, limit: pageSize,
    ...(state.cursor ? { cursor: state.cursor } : {}) };
}

/** Normalized search text, for matching the current search to a saved view. */
export const sameSearch = (left: string, right: string) => left.trim().replace(/\s+/g, ' ') === right.trim().replace(/\s+/g, ' ');
