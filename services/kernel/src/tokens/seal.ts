import { createHmac, timingSafeEqual } from 'node:crypto';

export type KeyRing = {
  current: number;
  keys: ReadonlyMap<number, Uint8Array>;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;
export const MAX_TOKEN_LENGTH = 4_096;

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) return undefined;
  return decoded;
}

export function seal(ring: KeyRing, scope: string, payload: unknown): string {
  const kid = ring.current;
  const key = ring.keys.get(kid);
  if (!Number.isInteger(kid) || kid < 0 || kid > 255 || !key || key.byteLength < 32)
    throw new Error('The current token signing key must exist and contain at least 32 bytes');

  const json = JSON.stringify(payload);
  if (json === undefined) throw new TypeError('Token payload must be JSON serializable');

  const body = encodeBase64Url(Buffer.concat([Buffer.from([1, kid]), Buffer.from(json, 'utf8')]));
  const mac = createHmac('sha256', key).update(`${scope}\0${body}`, 'utf8').digest('base64url');
  return `${body}.${mac}`;
}

export function unseal(ring: KeyRing, scope: string, token: string): unknown | undefined {
  try {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return undefined;
    const parts = token.split('.');
    if (parts.length !== 2) return undefined;
    const [encodedBody, encodedMac] = parts;
    if (encodedBody === undefined || encodedMac === undefined) return undefined;
    const body = decodeCanonicalBase64Url(encodedBody);
    const suppliedMac = decodeCanonicalBase64Url(encodedMac);
    if (!body || body.length < 2 || !suppliedMac || suppliedMac.length !== 32) return undefined;

    const version = body[0];
    const kid = body[1];
    if (version !== 1 || kid === undefined) return undefined;
    const key = ring.keys.get(kid);
    if (!key || key.byteLength < 32) return undefined;

    const expectedMac = createHmac('sha256', key).update(`${scope}\0${encodedBody}`, 'utf8').digest();
    if (expectedMac.length !== suppliedMac.length || !timingSafeEqual(expectedMac, suppliedMac)) return undefined;

    const json = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(2));
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}
