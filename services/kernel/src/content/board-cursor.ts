import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';

export type BoardCursorSort = 'newest' | 'oldest' | 'active' | 'hot';
export type BoardCursorViewer = { kind: 'account'; accountId: string } | { kind: 'anonymous' };

export type BoardCursorBinding = {
  boardId: string;
  query: string;
  sort: BoardCursorSort;
  /** Decimal board-home pin-set counter, read with the candidate range. */
  pinRevision: string;
  /** The caller supplies an authenticated account identity or an anonymous actor. */
  viewer: BoardCursorViewer;
};

export type BoardCursorKey = { createdAt: string; threadId: string };
export type BoardRankCursorKey = { rank: number; threadId: string };

export type BoardCursorResult =
  | { ok: true; epoch: number; after: BoardCursorKey }
  | { ok: false; reason: 'expired' | 'invalid' | 'stale' };
export type BoardRankCursorResult =
  | { ok: true; epoch: number; after: BoardRankCursorKey }
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

function isBoardRankCursorKey(value: unknown): value is BoardRankCursorKey {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.rank === 'number' &&
    Number.isFinite(key.rank) &&
    key.rank >= 0 &&
    typeof key.threadId === 'string' &&
    UUID.test(key.threadId)
  );
}

function coreBinding(binding: BoardCursorBinding): CursorBinding {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding))
    throw new TypeError('Invalid board cursor binding');
  if (typeof binding.boardId !== 'string') throw new TypeError('Invalid board id');
  if (typeof binding.pinRevision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(binding.pinRevision))
    throw new TypeError('Invalid board pin revision');
  if (typeof binding.query !== 'string') throw new TypeError('Invalid board query');
  if (!['newest', 'oldest', 'active', 'hot'].includes(binding.sort)) throw new TypeError('Invalid board sort');

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
      representation: 'pinned-cohort-v2',
      pinRevision: binding.pinRevision,
    },
  };
}

// The shared cursor MAC authenticates every operand. Encrypt the exact scanned
// boundary as well: a sparse page may end on an undisclosed thread or pin.
// Domain-separated keys keep this board representation independent of other lists.
function cipherKey(ring: KeyRing, kid: number): Buffer {
  const key = ring.keys.get(kid);
  if (!key || key.byteLength < 32) throw new TypeError('Invalid board cursor key');
  return createHmac('sha256', key).update('content.board.cursor.encryption.v2').digest();
}

function encodePosition(
  ring: KeyRing,
  binding: BoardCursorBinding,
  epoch: number,
  after: readonly string[],
  now: number,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(ring, ring.current), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(after), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  return encodeCursor(ring, coreBinding(binding), { epoch, after: [ring.current, payload] }, now);
}

function decodePosition(
  ring: KeyRing,
  binding: BoardCursorBinding,
  token: string,
  expectedEpoch: number,
  now: number,
): { ok: true; epoch: number; after: unknown[] } | { ok: false; reason: 'invalid' | 'expired' | 'stale' } {
  const decoded = decodeCursor(ring, coreBinding(binding), token, now);
  if (!decoded.ok) return decoded;
  if (decoded.epoch !== expectedEpoch) return { ok: false, reason: 'stale' };
  if (decoded.after.length !== 2) return { ok: false, reason: 'invalid' };
  const [kid, payload] = decoded.after;
  if (typeof kid !== 'number' || !Number.isInteger(kid) || typeof payload !== 'string')
    return { ok: false, reason: 'invalid' };
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length < 29 || bytes.toString('base64url') !== payload) return { ok: false, reason: 'invalid' };
  const cipher = createDecipheriv('aes-256-gcm', cipherKey(ring, kid), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  const after: unknown = JSON.parse(
    Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
  );
  if (!Array.isArray(after)) return { ok: false, reason: 'invalid' };
  return { ok: true, epoch: decoded.epoch, after };
}

/** Encode the last scanned row using the shared signed cursor format and lifetime. */
export function encodeBoardCursor(
  ring: KeyRing,
  binding: BoardCursorBinding,
  epoch: number,
  after: BoardCursorKey,
  now = Date.now(),
): string {
  if (binding.sort !== 'newest' && binding.sort !== 'oldest') throw new TypeError('Invalid board sort');
  if (!isBoardCursorKey(after)) throw new TypeError('Invalid board cursor key');
  return encodePosition(ring, binding, epoch, [after.createdAt, after.threadId], now);
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
    if (binding.sort !== 'newest' && binding.sort !== 'oldest') return { ok: false, reason: 'invalid' };
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) return { ok: false, reason: 'invalid' };
    const decoded = decodePosition(ring, binding, token, expectedEpoch, now);
    if (!decoded.ok) return decoded;
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

/** Encode a rank position using a cursor binding that includes active or hot sort. */
export function encodeBoardRankCursor(
  ring: KeyRing,
  binding: BoardCursorBinding,
  epoch: number,
  after: BoardRankCursorKey,
  now = Date.now(),
): string {
  if (binding.sort !== 'active' && binding.sort !== 'hot') throw new TypeError('Invalid ranked board sort');
  if (!isBoardRankCursorKey(after)) throw new TypeError('Invalid board rank cursor key');
  return encodePosition(ring, binding, epoch, [String(after.rank), after.threadId], now);
}

/** Decode a rank position only for its bound sort, board, query, viewer and epoch. */
export function decodeBoardRankCursor(
  ring: KeyRing,
  binding: BoardCursorBinding,
  token: string,
  expectedEpoch: number,
  now = Date.now(),
): BoardRankCursorResult {
  try {
    if (binding.sort !== 'active' && binding.sort !== 'hot') return { ok: false, reason: 'invalid' };
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) return { ok: false, reason: 'invalid' };
    const decoded = decodePosition(ring, binding, token, expectedEpoch, now);
    if (!decoded.ok) return decoded;
    const rank =
      decoded.after.length === 2 && typeof decoded.after[0] === 'string' ? Number(decoded.after[0]) : Number.NaN;
    const threadId = decoded.after.length === 2 ? decoded.after[1] : undefined;
    if (!Number.isFinite(rank) || rank < 0 || typeof threadId !== 'string' || !UUID.test(threadId))
      return { ok: false, reason: 'invalid' };
    return { ok: true, epoch: decoded.epoch, after: { rank, threadId } };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
