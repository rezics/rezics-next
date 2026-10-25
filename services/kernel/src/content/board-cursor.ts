import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';

export type BoardCursorSort = 'newest' | 'oldest';
export type BoardCursorViewer = { kind: 'account'; accountId: string } | { kind: 'anonymous' };

export type BoardCursorBinding = {
  boardId: string;
  query: string;
  sort: BoardCursorSort;
  /** The caller supplies an authenticated account identity or an anonymous actor. */
  viewer: BoardCursorViewer;
};

export type BoardCursorKey = { createdAt: string; threadId: string };

export type BoardCursorResult =
  | { ok: true; epoch: number; after: BoardCursorKey }
  | { ok: false; reason: 'expired' | 'invalid' | 'stale' };

const OPERATION = 'board.threads.list';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

/** Board listing queries strip surrounding whitespace and preserve all remaining authored text. */
export function normalizeBoardQuery(query: string): string {
  if (typeof query !== 'string') throw new TypeError('Board query must be a string');
  return query.trim();
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.toISOString().slice(0, 19) === value.slice(0, 19);
}

function isBoardCursorKey(value: unknown): value is BoardCursorKey {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return isTimestamp(key.createdAt) && typeof key.threadId === 'string' && UUID.test(key.threadId);
}

function coreBinding(binding: BoardCursorBinding): CursorBinding {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding))
    throw new TypeError('Invalid board cursor binding');
  if (typeof binding.boardId !== 'string') throw new TypeError('Invalid board id');
  if (typeof binding.query !== 'string') throw new TypeError('Invalid board query');
  if (binding.sort !== 'newest' && binding.sort !== 'oldest') throw new TypeError('Invalid board sort');

  let viewer: string | null;
  if (binding.viewer !== null && typeof binding.viewer === 'object' && !Array.isArray(binding.viewer)) {
    if (binding.viewer.kind === 'anonymous') viewer = null;
    else if (binding.viewer.kind === 'account' && typeof binding.viewer.accountId === 'string')
      viewer = binding.viewer.accountId;
    else throw new TypeError('Invalid board cursor viewer');
  } else throw new TypeError('Invalid board cursor viewer');

  return {
    operation: OPERATION,
    parameters: {
      boardId: binding.boardId,
      query: normalizeBoardQuery(binding.query),
      sort: binding.sort,
      viewer,
    },
  };
}

/** Encode the last scanned row using the shared signed cursor format and lifetime. */
export function encodeBoardCursor(
  ring: KeyRing,
  binding: BoardCursorBinding,
  epoch: number,
  after: BoardCursorKey,
  now = Date.now(),
): string {
  if (!isBoardCursorKey(after)) throw new TypeError('Invalid board cursor key');
  return encodeCursor(ring, coreBinding(binding), { epoch, after: [after.createdAt, after.threadId] }, now);
}

/** Decode for the caller's current epoch; malformed tokens and bindings return a typed failure. */
export function decodeBoardCursor(
  ring: KeyRing,
  binding: BoardCursorBinding,
  token: string,
  expectedEpoch: number,
  now = Date.now(),
): BoardCursorResult {
  try {
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) return { ok: false, reason: 'invalid' };
    const decoded = decodeCursor(ring, coreBinding(binding), token, now);
    if (!decoded.ok) return decoded;
    if (decoded.epoch !== expectedEpoch) return { ok: false, reason: 'stale' };
    if (
      decoded.after.length !== 2 ||
      !isTimestamp(decoded.after[0]) ||
      typeof decoded.after[1] !== 'string' ||
      !UUID.test(decoded.after[1])
    )
      return { ok: false, reason: 'invalid' };
    return {
      ok: true,
      epoch: decoded.epoch,
      after: { createdAt: decoded.after[0], threadId: decoded.after[1] },
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
