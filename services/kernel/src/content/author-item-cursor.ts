import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';

export type AuthorItemCursorKey = Readonly<{ createdAt: string; itemId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

function timestamp(value: unknown): value is string {
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

// A signed cursor alone is readable. Encrypt the boundary so skipped candidates
// cannot disclose their identities or creation times through continuation tokens.
function cursorCipherKey(ring: KeyRing, kid: number): Buffer {
  const key = ring.keys.get(kid);
  if (!key || key.byteLength < 32) throw new TypeError('Invalid content cursor');
  return createHmac('sha256', key).update('content.author-item.cursor.encryption.v1').digest();
}

export function encodeAuthorItemKey(
  ring: KeyRing,
  scope: CursorBinding,
  key: AuthorItemCursorKey,
  epoch: number,
  now: number,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorCipherKey(ring, ring.current), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(key), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  return encodeCursor(ring, scope, { epoch, after: [ring.current, payload] }, now);
}

export function decodeAuthorItemKey(
  ring: KeyRing,
  scope: CursorBinding,
  token: string,
  epoch: number,
  now: number,
): AuthorItemCursorKey {
  try {
    const decoded = decodeCursor(ring, scope, token, now);
    if (!decoded.ok || decoded.epoch !== epoch || decoded.after.length !== 2) throw new Error();
    const [kid, payload] = decoded.after;
    if (typeof kid !== 'number' || typeof payload !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error();
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== payload) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', cursorCipherKey(ring, kid), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const key: unknown = JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
    );
    if (
      !key ||
      typeof key !== 'object' ||
      !('createdAt' in key) ||
      !('itemId' in key) ||
      !timestamp(key.createdAt) ||
      typeof key.itemId !== 'string' ||
      !UUID.test(key.itemId) ||
      routeOf(key.itemId) === null
    )
      throw new Error();
    return { createdAt: key.createdAt, itemId: key.itemId };
  } catch {
    throw new TypeError('Invalid content cursor');
  }
}
