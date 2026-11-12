import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { decodeCursor, encodeCursor, type CursorBinding } from '../src/tokens/cursor.ts';
import { MAX_TOKEN_LENGTH, seal, unseal, type KeyRing } from '../src/tokens/seal.ts';
import { decodeSession, encodeSession, mergeSession, type SessionComponent } from '../src/tokens/session.ts';

const key = (byte: number) => new Uint8Array(32).fill(byte);
const ring: KeyRing = { current: 1, keys: new Map([[1, key(1)]]) };
const rotated: KeyRing = {
  current: 2,
  keys: new Map([
    [1, key(1)],
    [2, key(2)],
  ]),
};
const c = (partition: number, epoch: number, position: bigint): SessionComponent => ({ partition, epoch, position });

function handmade(version: number, kid: number, scope: string, payload: string): string {
  const body = Buffer.concat([Buffer.from([version, kid]), Buffer.from(payload)]).toString('base64url');
  return `${body}.${createHmac('sha256', key(kid)).update(`${scope}\0${body}`).digest('base64url')}`;
}

test('a sealed token is version and key id, JSON, and an HMAC over scope and body', () => {
  const token = seal(ring, 'account:7', { a: 1 });
  expect(token).toBe(handmade(1, 1, 'account:7', '{"a":1}'));
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  expect(unseal(ring, 'account:7', token)).toEqual({ a: 1 });
  expect(unseal(ring, 'account:7', handmade(2, 1, 'account:7', '{"a":1}'))).toBeUndefined();
  expect(unseal(ring, 'account:7', handmade(1, 1, 'account:7', '{"a":'))).toBeUndefined();
});

test('a sealed token opens only with its scope, its key and unaltered characters', () => {
  const token = seal(ring, 'account:7', { a: 1 });
  const [body, mac] = token.split('.') as [string, string];
  const flip = (part: string) => (part.startsWith('A') ? 'B' : 'A') + part.slice(1);
  expect(unseal(ring, 'account:8', token)).toBeUndefined();
  expect(unseal({ current: 1, keys: new Map([[1, key(9)]]) }, 'account:7', token)).toBeUndefined();
  for (const forged of [
    `${flip(body)}.${mac}`,
    `${body}.${flip(mac)}`,
    `${body}.${mac}.x`,
    body,
    `${body}.${mac}=`,
    `${body}+.${mac}`,
    '',
  ])
    expect(unseal(ring, 'account:7', forged)).toBeUndefined();
});

test('a rotated key ring seals with the current key and still opens older tokens', () => {
  const older = seal(ring, 's', 'x');
  const newer = seal(rotated, 's', 'x');
  expect(newer).toBe(handmade(1, 2, 's', '"x"'));
  expect(unseal(rotated, 's', older)).toBe('x');
  expect(unseal(ring, 's', newer)).toBeUndefined();
  expect(() => seal({ current: 3, keys: rotated.keys }, 's', 'x')).toThrow();
  expect(() => seal({ current: 1, keys: new Map([[1, new Uint8Array(16)]]) }, 's', 'x')).toThrow();
});

test('session components merge by partition and epoch, most recent write last', () => {
  const session = mergeSession(mergeSession([], c(5, 1, 10n)), c(9, 1, 3n));
  expect(session).toEqual([c(5, 1, 10n), c(9, 1, 3n)]);
  expect(mergeSession(session, c(5, 1, 12n))).toEqual([c(9, 1, 3n), c(5, 1, 12n)]);
  expect(mergeSession(session, c(5, 1, 7n))).toEqual([c(9, 1, 3n), c(5, 1, 10n)]);
  const moved = mergeSession(session, c(5, 2, 1n));
  expect(moved).toEqual([c(9, 1, 3n), c(5, 2, 1n)]);
  expect(mergeSession(moved, c(5, 1, 99n))).toEqual(moved);
  expect(session).toEqual([c(5, 1, 10n), c(9, 1, 3n)]);
});

test('a session keeps the 32 most recently written partitions', () => {
  let session: SessionComponent[] = [];
  for (let partition = 0; partition < 33; partition++) session = mergeSession(session, c(partition, 1, 1n));
  expect(session.map((component) => component.partition)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  session = mergeSession(mergeSession(session, c(1, 1, 2n)), c(40, 1, 1n));
  expect(session).toHaveLength(32);
  expect(session.slice(0, 2).map((component) => component.partition)).toEqual([3, 4]);
  expect(session.slice(-2)).toEqual([c(1, 1, 2n), c(40, 1, 1n)]);
});

test('session tokens carry 64-bit positions under the session scope only', () => {
  const session = [c(0, 1, 0n), c(4095, 3, 9_223_372_036_854_775_807n)];
  const token = encodeSession(ring, 'account:7', session);
  expect(decodeSession(ring, 'account:7', token)).toEqual(session);
  expect(decodeSession(ring, 'anonymous:7', token)).toBeUndefined();
  expect(decodeSession(ring, 'account:7', encodeSession(ring, 'account:7', []))).toEqual([]);
  expect(decodeSession(ring, 'account:7', seal(ring, 'session\0account:7', [[1, 2, '3']]))).toEqual([c(1, 2, 3n)]);
  expect(decodeSession(ring, 'account:7', seal(ring, 'account:7', [[1, 2, '3']]))).toBeUndefined();
  expect(() =>
    encodeSession(
      ring,
      'account:7',
      Array.from({ length: 33 }, (_, i) => c(i, 1, 0n)),
    ),
  ).toThrow();
});

test('session tokens with malformed components are rejected', () => {
  for (const payload of [
    {},
    [[1, 1]],
    [[4096, 1, '0']],
    [[-1, 1, '0']],
    [[1.5, 1, '0']],
    [[1, 0, '0']],
    [[1, 1, '-1']],
    [[1, 1, '01']],
    [[1, 1, 5]],
    [[1, 1, '9223372036854775808']],
    [
      [1, 1, '0'],
      [1, 1, '2'],
    ],
    Array.from({ length: 33 }, (_, i) => [i, 1, '0']),
  ])
    expect(decodeSession(ring, 'account:7', seal(ring, 'session\0account:7', payload))).toBeUndefined();
});

const binding: CursorBinding = { operation: 'listSubjects', parameters: { partition: 7, type: 'schema:Book' } };
const now = Date.UTC(2026, 9, 25, 12);

test('a cursor opens only for the operation and parameters it was issued for', () => {
  const token = encodeCursor(ring, binding, { epoch: 2, after: ['k', 3] }, now);
  expect(decodeCursor(ring, binding, token, now)).toEqual({ ok: true, epoch: 2, after: ['k', 3] });
  const reordered = { operation: 'listSubjects', parameters: { type: 'schema:Book', partition: 7 } };
  expect(decodeCursor(ring, reordered, token, now)).toEqual({ ok: true, epoch: 2, after: ['k', 3] });
  for (const other of [
    { ...binding, operation: 'listFacts' },
    { ...binding, parameters: { partition: 8, type: 'schema:Book' } },
    { ...binding, parameters: { partition: '7', type: 'schema:Book' } },
    { ...binding, parameters: { partition: 7 } },
  ])
    expect(decodeCursor(ring, other, token, now)).toEqual({ ok: false, reason: 'invalid' });
  expect(decodeCursor(ring, binding, 'garbage', now)).toEqual({ ok: false, reason: 'invalid' });
});

test('a cursor is a sealed epoch, keyset and issue time valid for 15 minutes', () => {
  const scope = 'cursor\0listSubjects\0{"partition":7,"type":"schema:Book"}';
  const token = seal(ring, scope, { e: 2, a: ['k', 3], t: now });
  expect(encodeCursor(ring, binding, { epoch: 2, after: ['k', 3] }, now)).toBe(token);
  expect(decodeCursor(ring, binding, token, now + 15 * 60_000)).toEqual({ ok: true, epoch: 2, after: ['k', 3] });
  expect(decodeCursor(ring, binding, token, now + 15 * 60_000 + 1)).toEqual({ ok: false, reason: 'expired' });
  expect(decodeCursor(ring, binding, token, now - 60_000)).toEqual({ ok: true, epoch: 2, after: ['k', 3] });
  expect(decodeCursor(ring, binding, token, now - 60_001)).toEqual({ ok: false, reason: 'invalid' });
  for (const payload of [
    { e: 0, a: [], t: now },
    { e: 1, a: [{}], t: now },
    { e: 1, a: [1.5], t: now },
    { e: 1, a: Array.from({ length: 9 }, () => 'k'), t: now },
    { e: 1, a: [] },
  ])
    expect(decodeCursor(ring, binding, seal(ring, scope, payload), now)).toEqual({ ok: false, reason: 'invalid' });
});

test('legacy cursors stay within the decoder limit for ASCII, UTF-8 and escaped keys', () => {
  const boundary: CursorBinding = { operation: 'boundary', parameters: {} };
  const scope = 'cursor\0boundary\0{}';
  const cases = [
    ['a'.repeat(3003), 'a'.repeat(3004)],
    ['界'.repeat(1001), `${'界'.repeat(1001)}a`],
    [`${'\\'.repeat(1501)}a`, '\\'.repeat(1502)],
  ] as const;

  for (const [readable, oversized] of cases) {
    const token = encodeCursor(ring, boundary, { epoch: 1, after: [readable] }, now);
    expect(token).toHaveLength(MAX_TOKEN_LENGTH);
    expect(decodeCursor(ring, boundary, token, now)).toMatchObject({ ok: true, epoch: 1 });

    const oversizedToken = seal(ring, scope, { e: 1, a: [oversized], t: now });
    expect(oversizedToken).toHaveLength(MAX_TOKEN_LENGTH + 2);
    expect(decodeCursor(ring, boundary, oversizedToken, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(() => encodeCursor(ring, boundary, { epoch: 1, after: [oversized] }, now)).toThrow(
      'Encoded cursor exceeds decoder limit',
    );
  }
});
