import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { LIST_COST } from '../../api-list.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadUnavailable,
  type ReadPosition } from '../work/read-session.ts';
import type { DirectoryAfter, LabelAfter } from '../search/labels.ts';

export interface ResourcePageCursor {
  after?: LabelAfter;
  seen: number;
  seeks: Record<string, { id: string; key: string }>;
  done: string[];
  directorySource?: ReadPosition;
}

/** The encrypted envelope and its admission share LIST_COST. Compress before
 * encryption: native seek keys repeat resource identities and owner prefixes.
 * The inflation bound is independent of the public token's character bound.
 * Tokens locate a continuation; every page still proves current disclosure.
 * https://google.aip.dev/158 */
const STATE_BYTES = 8192;
const VERSION = 'resource-list-v3';
export function readResourceCursor(token: string | undefined, binding: unknown,
  position: ReadPosition, kinds: readonly string[]): ResourcePageCursor {
  const cursor = decodeReadCursor(token, [VERSION, binding], position);
  if (!cursor) return { seen: 0, seeks: {}, done: [] };
  try {
    const state: ResourcePageCursor = JSON.parse(inflateRawSync(Buffer.from(cursor.order, 'base64url'),
      { maxOutputLength: STATE_BYTES }).toString());
    if (!Number.isSafeInteger(state.seen) || state.seen < 0
      || !state.seeks || typeof state.seeks !== 'object' || Array.isArray(state.seeks)
      || Object.entries(state.seeks).some(([kind, seek]) => !kinds.includes(kind)
        || !seek || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(seek.id)
        || typeof seek.key !== 'string')
      || !Array.isArray(state.done) || state.done.some(kind => !kinds.includes(kind))
      || new Set(state.done).size !== state.done.length) throw new Error('state');
    return state;
  } catch { throw new WorkReadInvalid('Resource cursor is invalid'); }
}

export function resourcePageCursor(binding: unknown, position: ReadPosition,
  state: ResourcePageCursor): string {
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > STATE_BYTES) throw new WorkReadUnavailable('Resource seek state exceeds its bound');
  const order = deflateRawSync(json).toString('base64url');
  // The last resource is already retained by its source seek (or ranked after).
  const cursor = encodeReadCursor([VERSION, binding], position, '', order);
  if (cursor.length > LIST_COST.cursorCharacters)
    throw new WorkReadUnavailable('Resource continuation exceeds its admitted bound');
  return cursor;
}

export function directoryResourceSeek(key: string): DirectoryAfter {
  try { return JSON.parse(key) as DirectoryAfter; }
  catch { throw new WorkReadInvalid('Resource directory cursor is invalid'); }
}
