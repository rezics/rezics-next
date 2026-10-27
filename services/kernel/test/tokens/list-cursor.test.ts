import { expect, test } from 'bun:test';
import { seal, type KeyRing } from '../../src/tokens/seal.ts';
import { decodeCursor } from '../../src/tokens/cursor.ts';
import {
  decodeListCursor,
  encodeListCursor,
  type ListCursorBinding,
  type ListCursorPosition,
  type ListCursorResult,
} from '../../src/tokens/list-cursor.ts';

const key = (byte: number) => new Uint8Array(32).fill(byte);
const ring: KeyRing = { current: 1, keys: new Map([[1, key(1)]]) };
const rotated: KeyRing = {
  current: 2,
  keys: new Map([
    [1, key(1)],
    [2, key(2)],
  ]),
};
const retired: KeyRing = { current: 2, keys: new Map([[2, key(2)]]) };
const now = new Date('2026-10-27T12:00:00.000Z');
const later = (ms: number) => new Date(now.getTime() + ms);
const viewerId = '0b9f3c1e-5d2a-4e7b-9a41-6c8d2f1e7a35';
const otherViewerId = '1c0a4d2f-6e3b-4f8c-8b52-7d9e3a2f8b46';
const binding: ListCursorBinding = {
  route: 'GET /v1/agent-pages',
  viewer: viewerId,
  query: { sort: 'recent', size: 20, hidden: false, after: null },
};
const position: ListCursorPosition = {
  epoch: 7,
  after: ['a-list-cursor-secret-position', 9_007_199_254_740_991],
};

const flip = (token: string, index: number) =>
  token.slice(0, index) + (token[index] === 'A' ? 'B' : 'A') + token.slice(index + 1);

test('a cursor round-trips its epoch and after-keys for the same route viewer and query', async () => {
  const token = await encodeListCursor(ring, binding, position, now);
  expect(await decodeListCursor(ring, binding, token, now)).toEqual({
    ok: true,
    epoch: 7,
    after: [...position.after],
  });
  // Query key order does not matter.
  const reordered = {
    ...binding,
    query: { after: null, hidden: false, size: 20, sort: 'recent' },
  };
  expect((await decodeListCursor(ring, reordered, token, now)).ok).toBe(true);
  const anonymous = { ...binding, viewer: null };
  const anonymousToken = await encodeListCursor(ring, anonymous, { epoch: 1, after: [] }, now);
  expect(await decodeListCursor(ring, anonymous, anonymousToken, now)).toEqual({
    ok: true,
    epoch: 1,
    after: [],
  });
});

test('the token reveals nothing of its position and two encodings of one position differ', async () => {
  const uuid = '5f0e8a2c-71d4-4b6a-93c8-e2a41b7d0f19';
  const long = 'distinctive-ascii-position-'.repeat(8);
  const large = 9_007_199_254_740_881;
  const token = await encodeListCursor(ring, binding, { epoch: 4_242_424, after: [uuid, long, large] }, now);
  const bytes = Buffer.from(token, 'base64url');
  for (const secret of [uuid, long, String(large), '4242424']) {
    expect(token).not.toContain(secret);
    expect(bytes.toString('latin1')).not.toContain(secret);
    expect(bytes.toString('utf8')).not.toContain(secret);
    expect(Buffer.from(token, 'base64url').toString('base64')).not.toContain(Buffer.from(secret).toString('base64'));
  }
  const again = await encodeListCursor(ring, binding, { epoch: 4_242_424, after: [uuid, long, large] }, now);
  expect(again).not.toBe(token);
  expect(await decodeListCursor(ring, binding, again, now)).toEqual(await decodeListCursor(ring, binding, token, now));
});

test('any changed truncated extended or non-canonical token decodes as invalid', async () => {
  const token = await encodeListCursor(ring, binding, position, now);
  const decode = (value: string) => decodeListCursor(ring, binding, value, now);
  for (let index = 0; index < token.length; index += 1) {
    const result = await decode(flip(token, index));
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  }
  for (const value of [
    token.slice(0, -1),
    token.slice(0, 20),
    token.slice(2),
    '',
    `${token}A`,
    `${token}AA`,
    `${token}=`,
    `${token}.`,
    ` ${token}`,
    `${token}\n`,
    token.replaceAll('-', '+').replaceAll('_', '/'),
    '!!!!',
  ])
    expect(await decode(value)).toEqual({ ok: false, reason: 'invalid' });
  // A non-canonical final character that decodes to the same bytes is refused.
  const last = token.at(-1) as string;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (const alternative of alphabet) {
    if (alternative === last) continue;
    expect(await decode(token.slice(0, -1) + alternative)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  }
  for (const garbage of [null, undefined, 7, {}, []] as unknown[])
    expect(await decodeListCursor(ring, binding, garbage as string, now)).toEqual({ ok: false, reason: 'invalid' });
});

test('a different viewer route or query decodes as invalid including anonymous against an account and the reverse', async () => {
  const token = await encodeListCursor(ring, binding, position, now);
  const invalid: ListCursorResult = { ok: false, reason: 'invalid' };
  for (const other of [
    { ...binding, viewer: otherViewerId },
    { ...binding, viewer: null },
    { ...binding, route: 'GET /v1/other-pages' },
    { ...binding, route: 'GET /v1/agent-pages ' },
    { ...binding, query: { ...binding.query, size: 21 } },
    { ...binding, query: { ...binding.query, size: '20' } },
    { ...binding, query: { sort: 'recent', size: 20, hidden: false } },
    { ...binding, query: { ...binding.query, extra: true } },
  ])
    expect(await decodeListCursor(ring, other, token, now)).toEqual(invalid);

  const anonymous = { ...binding, viewer: null };
  const anonymousToken = await encodeListCursor(ring, anonymous, position, now);
  expect(await decodeListCursor(ring, binding, anonymousToken, now)).toEqual(invalid);
  expect((await decodeListCursor(ring, anonymous, anonymousToken, now)).ok).toBe(true);

  await expect(encodeListCursor(ring, { ...binding, viewer: viewerId.toUpperCase() }, position, now)).rejects.toThrow(
    TypeError,
  );
  await expect(encodeListCursor(ring, { ...binding, viewer: 'not-a-uuid' }, position, now)).rejects.toThrow(TypeError);
  await expect(
    encodeListCursor(ring, { ...binding, viewer: undefined as unknown as null }, position, now),
  ).rejects.toThrow(TypeError);
  expect(await decodeListCursor(ring, { ...binding, viewer: viewerId.toUpperCase() }, token, now)).toEqual(invalid);
  expect(await decodeListCursor(ring, { ...binding, viewer: 'x' }, token, now)).toEqual(invalid);
  expect(await decodeListCursor(ring, null as unknown as ListCursorBinding, token, now)).toEqual(invalid);
});

test('a token whose key id left the ring decodes as invalid', async () => {
  const token = await encodeListCursor(ring, binding, position, now);
  expect(await decodeListCursor(retired, binding, token, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await decodeListCursor({ current: 1, keys: new Map([[1, key(9)]]) }, binding, token, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
});

test('after rotation a cursor from the previous key still decodes and new cursors use the new current key', async () => {
  const old = await encodeListCursor(ring, binding, position, now);
  expect(Buffer.from(old, 'base64url')[1]).toBe(1);
  expect((await decodeListCursor(rotated, binding, old, now)).ok).toBe(true);
  const fresh = await encodeListCursor(rotated, binding, position, now);
  expect(Buffer.from(fresh, 'base64url')[1]).toBe(2);
  expect((await decodeListCursor(rotated, binding, fresh, now)).ok).toBe(true);
  expect((await decodeListCursor(retired, binding, fresh, now)).ok).toBe(true);
  expect((await decodeListCursor(retired, binding, old, now)).ok).toBe(false);
  // The key id is authenticated: relabelling a token to another ring key fails.
  const relabelled = Buffer.from(old, 'base64url');
  relabelled[1] = 2;
  expect((await decodeListCursor(rotated, binding, relabelled.toString('base64url'), now)).ok).toBe(false);
});

test('expiry and future issuance are read from the passed clock', async () => {
  const token = await encodeListCursor(ring, binding, position, now);
  const at = (ms: number) => decodeListCursor(ring, binding, token, later(ms));
  expect((await at(0)).ok).toBe(true);
  expect((await at(15 * 60_000)).ok).toBe(true);
  expect(await at(15 * 60_000 + 1)).toEqual({ ok: false, reason: 'expired' });
  expect((await at(-60_000)).ok).toBe(true);
  expect(await at(-60_001)).toEqual({ ok: false, reason: 'invalid' });
  expect(await decodeListCursor(ring, binding, token, new Date(Number.NaN))).toEqual({ ok: false, reason: 'invalid' });
  await expect(encodeListCursor(ring, binding, position, new Date(Number.NaN))).rejects.toThrow(TypeError);
});

test('oversized inputs are refused', async () => {
  const encode = (b: ListCursorBinding, p: ListCursorPosition) => encodeListCursor(ring, b, p, now);
  await expect(encode({ ...binding, route: 'r'.repeat(257) }, position)).rejects.toThrow(TypeError);
  await expect(encode({ ...binding, route: 'é'.repeat(129) }, position)).rejects.toThrow(TypeError);
  await expect(encode({ ...binding, query: { q: 'x'.repeat(2_048) } }, position)).rejects.toThrow(TypeError);
  await expect(encode(binding, { epoch: 1, after: ['x'.repeat(257)] })).rejects.toThrow(TypeError);
  await expect(encode(binding, { epoch: 1, after: ['é'.repeat(129)] })).rejects.toThrow(TypeError);
  await expect(encode(binding, { epoch: 1, after: Array.from({ length: 9 }, () => 'a') })).rejects.toThrow(TypeError);
  await expect(encode(binding, { epoch: 0, after: [] })).rejects.toThrow(TypeError);
  await expect(encode(binding, { epoch: 1, after: [1.5] })).rejects.toThrow(TypeError);
  await expect(encode(binding, { epoch: 1, after: [2 ** 53] })).rejects.toThrow(TypeError);
  await expect(
    encodeListCursor({ current: 1, keys: new Map([[1, new Uint8Array(31)]]) }, binding, position, now),
  ).rejects.toThrow();

  const token = await encode(binding, position);
  expect(await decodeListCursor(ring, binding, token + 'A'.repeat(5_000), now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await decodeListCursor(ring, binding, 'A'.repeat(4_097), now)).toEqual({ ok: false, reason: 'invalid' });
  expect(await decodeListCursor(ring, { ...binding, route: 'r'.repeat(257) }, token, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await decodeListCursor(ring, { ...binding, query: { q: 'x'.repeat(2_048) } }, token, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });

  const maximal = await encodeListCursor(
    ring,
    {
      route: 'r'.repeat(256),
      viewer: viewerId,
      query: { q: 'x'.repeat(2_048 - '{"q":""}'.length) },
    },
    {
      epoch: Number.MAX_SAFE_INTEGER,
      after: Array.from({ length: 8 }, () => 'x'.repeat(256)),
    },
    now,
  );
  expect(maximal.length).toBeLessThanOrEqual(4_096);
  expect(
    (
      await decodeListCursor(
        ring,
        {
          route: 'r'.repeat(256),
          viewer: viewerId,
          query: { q: 'x'.repeat(2_048 - '{"q":""}'.length) },
        },
        maximal,
        now,
      )
    ).ok,
  ).toBe(true);
});

test('a token from the HMAC seal is not a list cursor and a list cursor is not a sealed token', async () => {
  const sealed = seal(ring, 'cursor\0GET /v1/agent-pages\0{}', {
    e: 1,
    a: [],
    t: now.getTime(),
  });
  expect(await decodeListCursor(ring, binding, sealed, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await decodeListCursor(ring, binding, sealed.split('.')[0] as string, now)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  const token = await encodeListCursor(ring, binding, position, now);
  expect(decodeCursor(ring, { operation: binding.route, parameters: binding.query }, token, now.getTime())).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(
    decodeCursor(ring, { operation: binding.route, parameters: binding.query }, `${token}.${token}`, now.getTime()),
  ).toEqual({ ok: false, reason: 'invalid' });
});
