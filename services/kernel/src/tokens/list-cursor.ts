import { canonicalParameters, type CursorKey, type CursorResult } from './cursor.ts';
import type { KeyRing } from './seal.ts';

export type ListCursorBinding = {
  /** The list's identity: its method and path template ('GET /v1/agent-pages') or a feed's fixed name. */
  route: string;
  /** The acting account's id, or null for an anonymous viewer. */
  viewer: string | null;
  /** Every query parameter that shapes the list (filters, sort, page size), canonicalized by sorted key. */
  query: Readonly<Record<string, string | number | boolean | null>>;
};
export type ListCursorPosition = {
  epoch: number;
  after: readonly (string | number)[];
};
export type ListCursorResult = CursorResult;

const VERSION = 1;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const HEADER_BYTES = 2 + SALT_BYTES;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_ROUTE_BYTES = 256;
const MAX_QUERY_BYTES = 2_048;
const MAX_AFTER_KEY_BYTES = 256;
const MAX_AFTER_KEYS = 8;
const MAX_FUTURE_MS = 60_000;
const LIFETIME_MS = 15 * 60_000;
const HKDF_INFO = new TextEncoder().encode('rezics/list-cursor/v1');
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (): ListCursorResult => ({ ok: false, reason: 'invalid' });

const encoder = new TextEncoder();
const hkdfKeys = new WeakMap<Uint8Array, Promise<CryptoKey>>();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function hkdfKey(key: Uint8Array): Promise<CryptoKey> {
  let imported = hkdfKeys.get(key);
  if (imported === undefined) {
    imported = crypto.subtle.importKey('raw', key.slice(), 'HKDF', false, ['deriveBits']);
    hkdfKeys.set(key, imported);
  }
  return imported;
}

async function perTokenKey(
  key: Uint8Array,
  salt: Uint8Array,
): Promise<{ aes: CryptoKey; iv: Uint8Array<ArrayBuffer> }> {
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt.slice(), info: HKDF_INFO },
      await hkdfKey(key),
      352,
    ),
  );
  const aes = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { aes, iv: bits.slice(32, 44) };
}

/** Throws `TypeError` for a binding outside the contract. */
function associatedData(kid: number, binding: ListCursorBinding): Uint8Array<ArrayBuffer> {
  if (binding === null || typeof binding !== 'object' || typeof binding.route !== 'string' || binding.route === '')
    throw new TypeError('Invalid list cursor binding');
  if (byteLength(binding.route) > MAX_ROUTE_BYTES) throw new TypeError('The list cursor route is too long');
  const { viewer } = binding;
  if (viewer !== null && (typeof viewer !== 'string' || !UUID.test(viewer)))
    throw new TypeError('The list cursor viewer must be a lowercase UUID or null');
  const query = canonicalParameters(binding.query);
  if (byteLength(query) > MAX_QUERY_BYTES) throw new TypeError('The list cursor query is too long');
  return encoder.encode(
    JSON.stringify([
      'list-cursor',
      VERSION,
      kid,
      binding.route,
      viewer === null ? 'anonymous' : 'account',
      viewer,
      query,
    ]),
  );
}

function validAfter(after: unknown): after is CursorKey[] {
  return (
    Array.isArray(after) &&
    after.length <= MAX_AFTER_KEYS &&
    after.every(
      (value) =>
        (typeof value === 'string' && byteLength(value) <= MAX_AFTER_KEY_BYTES) ||
        (typeof value === 'number' && Number.isSafeInteger(value)),
    )
  );
}

export async function encodeListCursor(
  ring: KeyRing,
  binding: ListCursorBinding,
  position: ListCursorPosition,
  now: Date,
): Promise<string> {
  const kid = ring.current;
  const key = ring.keys.get(kid);
  if (!Number.isInteger(kid) || kid < 0 || kid > 255 || !key || key.byteLength < 32)
    throw new Error('The current token key must exist and contain at least 32 bytes');
  const issuedAt = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isSafeInteger(issuedAt)) throw new TypeError('Invalid list cursor time');
  if (
    position === null ||
    typeof position !== 'object' ||
    !Number.isSafeInteger(position.epoch) ||
    position.epoch < 1 ||
    !validAfter(position.after)
  )
    throw new TypeError('Invalid list cursor position');
  const data = associatedData(kid, binding);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const { aes, iv } = await perTokenKey(key, salt);
  const plaintext = encoder.encode(JSON.stringify({ e: position.epoch, a: position.after, t: issuedAt }));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: data, tagLength: TAG_BYTES * 8 },
      aes,
      plaintext,
    ),
  );
  const token = Buffer.concat([Buffer.from([VERSION, kid]), salt, sealed]).toString('base64url');
  if (token.length > MAX_TOKEN_LENGTH) throw new TypeError('The list cursor is too long');
  return token;
}

export async function decodeListCursor(
  ring: KeyRing,
  binding: ListCursorBinding,
  token: string,
  now: Date,
): Promise<ListCursorResult> {
  try {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !BASE64URL.test(token)) return invalid();
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token || bytes.length < HEADER_BYTES + TAG_BYTES + 1) return invalid();
    const [version, kid] = [bytes[0], bytes[1]];
    if (version !== VERSION || kid === undefined) return invalid();
    const key = ring.keys.get(kid);
    if (!key || key.byteLength < 32) return invalid();
    const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isSafeInteger(nowMs)) return invalid();
    const data = associatedData(kid, binding);

    const { aes, iv } = await perTokenKey(key, bytes.subarray(2, HEADER_BYTES));
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: data, tagLength: TAG_BYTES * 8 },
        aes,
        bytes.subarray(HEADER_BYTES),
      ),
    );
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return invalid();
    const value = payload as Record<string, unknown>;
    if (
      !Number.isSafeInteger(value.e) ||
      (value.e as number) < 1 ||
      !validAfter(value.a) ||
      !Number.isSafeInteger(value.t)
    )
      return invalid();
    const issuedAt = value.t as number;
    if (issuedAt - nowMs > MAX_FUTURE_MS) return invalid();
    if (nowMs - issuedAt > LIFETIME_MS) return { ok: false, reason: 'expired' };
    return { ok: true, epoch: value.e as number, after: value.a };
  } catch {
    return invalid();
  }
}
