import { normalizedSearchText, SEARCH_FIELD_COST } from './fields.ts';
import { PublicQueryUnavailable } from '../work/search-budget.ts';

export const PREFIX_WALK_COST = { maxPageSize: SEARCH_FIELD_COST.typeaheadItems,
  examinedPerItem: 4, cursorBytes: 2_048 } as const;

declare const cursorBrand: unique symbol;
/** Opaque to API consumers; the native producer and Main validator share the wire format below. */
export type PrefixWalkCursor = string & { readonly [cursorBrand]: true };
export type PrefixWalkField = 'title' | 'credit';
export interface PrefixWalkRequest {
  prefix: string;
  language: string | null;
  /** Native entries, including rejected entries, rather than accepted suggestions. */
  pageSize: number;
  cursor: PrefixWalkCursor | null;
}
export interface PrefixWalkEntry {
  key: string;
  mainVersion: string;
  matchUnit: string;
  matchedField: PrefixWalkField;
  /** Deleted, stale or otherwise inadmissible native entries still advance the walk. */
  rejected: boolean;
}
export interface PrefixWalkResponse {
  entries: PrefixWalkEntry[];
  generation: string;
  examined: number;
  rejected: number;
  more: boolean;
  cursor: PrefixWalkCursor | null;
}
interface CursorState {
  version: 1;
  prefix: string;
  language: string | null;
  /** Native reader generation: a changed generation must refuse/restart, never silently seek. */
  generation: string;
  after: string;
}

const PRODUCT = 'https://rezics.com/id/';
const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const KEY = /^[01][0-9a-f]{64}$/u;
const GENERATION = /^(0|[1-9][0-9]{0,63})$/u;
function malformed(reason: string): never {
  throw new PublicQueryUnavailable(`Malformed native prefix walk: ${reason}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function pageSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 1 || size > PREFIX_WALK_COST.maxPageSize) {
    throw new RangeError('Invalid prefix walk page size');
  }
  return size;
}
export function prefixWalkExaminedLimit(size: number): number {
  return pageSize(size) * PREFIX_WALK_COST.examinedPerItem;
}

/** Within one normalized prefix/language scope, native UTF-8 terms use this suffix:
 * tier digit + lowercase Main UUID without hyphens + lowercase unit UUID without hyphens.
 * Fixed width and alphabet 0-9a-f make byte order equal key.localeCompare and the
 * existing title-before-credit, mainVersion.localeCompare, matchUnit.localeCompare order.
 * Names are NFC/lowercase/space-normalized lookup scopes, never collation keys.
 * https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/index/TermsEnum.html */
export function prefixWalkDirectoryKey(entry: Pick<PrefixWalkEntry, 'matchedField' | 'mainVersion' | 'matchUnit'>): string {
  if (!ID.test(entry.mainVersion) || !ID.test(entry.matchUnit)
    || (entry.matchedField !== 'title' && entry.matchedField !== 'credit')) malformed('entry identity');
  return `${entry.matchedField === 'title' ? '0' : '1'}${entry.mainVersion.slice(PRODUCT.length).replaceAll('-', '')}${entry.matchUnit.slice(PRODUCT.length).replaceAll('-', '')}`;
}

function cursorState(cursor: PrefixWalkCursor, input: Pick<PrefixWalkRequest, 'prefix' | 'language'>): CursorState {
  if (typeof cursor !== 'string' || cursor.length > PREFIX_WALK_COST.cursorBytes
    || !/^[A-Za-z0-9_-]+$/u.test(cursor)) malformed('cursor encoding');
  let value: unknown;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) malformed('cursor encoding');
    value = JSON.parse(bytes.toString('utf8'));
  } catch { malformed('cursor encoding'); }
  if (!record(value) || value.version !== 1 || value.prefix !== input.prefix || value.language !== input.language
    || typeof value.after !== 'string' || !KEY.test(value.after)
    || typeof value.generation !== 'string' || !GENERATION.test(value.generation)) malformed('cursor scope');
  return value as unknown as CursorState;
}

/** Shared native cursor serialization. Consumers keep this token opaque. */
export function prefixWalkCursor(input: Pick<PrefixWalkRequest, 'prefix' | 'language'>,
  generation: string, after: string): PrefixWalkCursor {
  const cursor = Buffer.from(JSON.stringify({ version: 1, prefix: input.prefix,
    language: input.language, generation, after } satisfies CursorState)).toString('base64url') as PrefixWalkCursor;
  cursorState(cursor, input);
  return cursor;
}

export function prefixWalkRequest(input: { prefix: string; language: string | null; pageSize: number;
  cursor?: PrefixWalkCursor | null }): PrefixWalkRequest {
  const request = { prefix: normalizedSearchText(input.prefix), language: input.language?.toLowerCase() ?? null,
    pageSize: pageSize(input.pageSize), cursor: input.cursor ?? null };
  if (!request.prefix) throw new RangeError('Prefix walk requires a nonempty prefix');
  if (request.cursor !== null) cursorState(request.cursor, request);
  return request;
}

/** Refuse over-budget, unsorted, stale-generation or non-advancing native responses.
 * Every examined entry is represented, even a rejected tombstone. No hidden
 * population scan may be reported as only the successful rows. `more` may peek
 * the next dictionary term but must not resolve another candidate/witness. */
export function validatePrefixWalkResponse(value: unknown, request: PrefixWalkRequest): PrefixWalkResponse {
  const previous = request.cursor === null ? null : cursorState(request.cursor, request);
  if (!record(value) || !Array.isArray(value.entries) || value.entries.length > request.pageSize
    || !Number.isSafeInteger(value.examined) || value.examined !== value.entries.length
    || !Number.isSafeInteger(value.rejected) || typeof value.more !== 'boolean'
    || typeof value.generation !== 'string' || !GENERATION.test(value.generation)) malformed('response counts');
  if (previous && value.generation !== previous.generation) malformed('response generation');
  let after = previous?.after ?? '';
  let rejected = 0;
  const entries: PrefixWalkEntry[] = [];
  for (const candidate of value.entries) {
    if (!record(candidate) || typeof candidate.key !== 'string' || typeof candidate.mainVersion !== 'string'
      || typeof candidate.matchUnit !== 'string' || (candidate.matchedField !== 'title' && candidate.matchedField !== 'credit')
      || typeof candidate.rejected !== 'boolean') malformed('entry shape');
    const entry = candidate as unknown as PrefixWalkEntry;
    if (entry.key !== prefixWalkDirectoryKey(entry) || after.localeCompare(entry.key) >= 0) malformed('entry order');
    after = entry.key;
    rejected += Number(entry.rejected);
    entries.push({ key: entry.key, mainVersion: entry.mainVersion, matchUnit: entry.matchUnit,
      matchedField: entry.matchedField, rejected: entry.rejected });
  }
  if (value.rejected !== rejected) malformed('rejection count');
  if (value.more) {
    if (!entries.length || typeof value.cursor !== 'string') malformed('non-advancing cursor');
    const next = cursorState(value.cursor as PrefixWalkCursor, request);
    if (next.after !== after || next.generation !== value.generation) malformed('cursor position');
  } else if (value.cursor !== null) malformed('terminal cursor');
  return { entries, generation: value.generation, examined: entries.length, rejected, more: value.more,
    cursor: value.cursor as PrefixWalkCursor | null };
}

export interface PrefixWalkPage<T> {
  items: T[];
  examined: number;
  rejected: number;
  hasMore: boolean;
  cursor: PrefixWalkCursor | null;
}
/** Main owns disclosure, mute filtering, deduplication and presentation. The
 * consumer returns null for any rejection; errors (including snapshot movement)
 * propagate instead of publishing a partial success. Deduplication is scoped to
 * this page; a consumer needing retained cross-page exclusions owns that policy. */
export async function fillPrefixWalkPage<T>(input: Parameters<typeof prefixWalkRequest>[0],
  walk: (request: PrefixWalkRequest) => Promise<unknown>,
  accept: (entry: PrefixWalkEntry) => Promise<T | null>): Promise<PrefixWalkPage<T>> {
  const initial = prefixWalkRequest(input);
  const cap = prefixWalkExaminedLimit(initial.pageSize);
  const items: T[] = [];
  const seen = new Set<string>();
  let examined = 0, rejected = 0, cursor = initial.cursor, hasMore = false;
  do {
    // Never fetch more entries than free slots: accepted entries cannot be lost
    // behind a cursor when the page fills halfway through a native batch.
    const request = { ...initial, cursor, pageSize: Math.min(initial.pageSize - items.length, cap - examined) };
    const response = validatePrefixWalkResponse(await walk(request), request);
    examined += response.examined;
    for (const entry of response.entries) {
      if (entry.rejected || seen.has(entry.mainVersion)) { rejected++; continue; }
      const item = await accept(entry);
      if (item === null) { rejected++; continue; }
      seen.add(entry.mainVersion);
      items.push(item);
    }
    cursor = response.cursor;
    hasMore = response.more;
  } while (hasMore && items.length < initial.pageSize && examined < cap);
  return { items, examined, rejected, hasMore, cursor };
}
