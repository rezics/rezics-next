import { expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import { seal, type KeyRing } from '../../src/tokens/seal.ts';
import { decodeCursor } from '../../src/tokens/cursor.ts';
import {
  decodeListCursor,
  encodeListCursor,
  LIST_CURSOR_BOUNDS,
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

test('encoding the same anonymous route query and position twice at different times gives the identical token', async () => {
  const anonymous = { ...binding, viewer: null };
  const token = await encodeListCursor(ring, anonymous, position, now);
  const reordered = { ...anonymous, query: { after: null, hidden: false, size: 20, sort: 'recent' } };
  expect(await encodeListCursor(ring, reordered, position, later(365 * 24 * 60 * 60_000))).toBe(token);
});

test('an anonymous cursor still decodes a day and a year after issue', async () => {
  const anonymous = { ...binding, viewer: null };
  const token = await encodeListCursor(ring, anonymous, position, now);
  for (const elapsed of [-60_001, 24 * 60 * 60_000, 365 * 24 * 60 * 60_000]) {
    expect(await decodeListCursor(rotated, anonymous, token, later(elapsed))).toEqual({
      ok: true,
      epoch: position.epoch,
      after: [...position.after],
    });
  }
  expect(await encodeListCursor(rotated, anonymous, position, now)).not.toBe(token);
});

test('a different position or query gives a different anonymous token', async () => {
  const anonymous = { ...binding, viewer: null };
  const token = await encodeListCursor(ring, anonymous, position, now);
  for (const other of [
    { ...position, epoch: position.epoch + 1 },
    { ...position, after: ['another-position', position.after[1]!] },
    { ...position, after: [...position.after].reverse() },
  ])
    expect(await encodeListCursor(ring, anonymous, other, now)).not.toBe(token);
  for (const other of [
    { ...anonymous, query: { ...anonymous.query, size: 21 } },
    { ...anonymous, query: { ...anonymous.query, size: '20' } },
    { ...anonymous, route: 'GET /v1/other-pages' },
  ]) {
    expect(await encodeListCursor(ring, other, position, now)).not.toBe(token);
    expect(await decodeListCursor(ring, other, token, now)).toEqual({ ok: false, reason: 'invalid' });
  }
});

test('tampering and an unknown or retired key id answer invalid for both kinds', async () => {
  for (const viewer of [null, viewerId]) {
    const bound = { ...binding, viewer };
    const token = await encodeListCursor(ring, bound, position, now);
    for (let index = 0; index < token.length; index += 1)
      expect(await decodeListCursor(ring, bound, flip(token, index), now)).toEqual({ ok: false, reason: 'invalid' });
    expect(await decodeListCursor(retired, bound, token, now)).toEqual({ ok: false, reason: 'invalid' });
    const unknown = Buffer.from(token, 'base64url');
    unknown[1] = 255;
    expect(await decodeListCursor(ring, bound, unknown.toString('base64url'), now)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  }
});

test('anonymous salts authenticate associated data and timeless plaintext with a separate HKDF key', async () => {
  const anonymous = { ...binding, viewer: null };
  const token = await encodeListCursor(ring, anonymous, position, now);
  const bytes = Buffer.from(token, 'base64url');
  const salt = bytes.subarray(2, 18);
  const data = Buffer.from(
    JSON.stringify([
      'list-cursor',
      1,
      1,
      anonymous.route,
      'anonymous',
      null,
      JSON.stringify({ after: null, hidden: false, size: 20, sort: 'recent' }),
    ]),
  );
  const material = Buffer.from(hkdfSync('sha256', key(1), salt, 'rezics/list-cursor/v1', 44));
  const decipher = createDecipheriv('aes-256-gcm', material.subarray(0, 32), material.subarray(32));
  decipher.setAAD(data);
  decipher.setAuthTag(bytes.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(18, -16)), decipher.final()]);
  expect(plaintext.toString()).toBe(JSON.stringify({ e: position.epoch, a: position.after }));
  const sivKey = hkdfSync('sha256', key(1), Buffer.alloc(0), 'rezics/list-cursor/v1/siv', 32);
  const expectedSalt = createHmac('sha256', sivKey).update(data).update(plaintext).digest().subarray(0, 16);
  expect(salt).toEqual(expectedSalt);

  // A valid GCM tag alone is insufficient: decoding must also verify the synthetic salt.
  const wrongSalt = Buffer.from(salt);
  wrongSalt[0] = wrongSalt[0]! ^ 1;
  const wrongMaterial = Buffer.from(hkdfSync('sha256', key(1), wrongSalt, 'rezics/list-cursor/v1', 44));
  const cipher = createCipheriv('aes-256-gcm', wrongMaterial.subarray(0, 32), wrongMaterial.subarray(32));
  cipher.setAAD(data);
  const forged = Buffer.concat([
    bytes.subarray(0, 2),
    wrongSalt,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64url');
  expect(await decodeListCursor(ring, anonymous, forged, now)).toEqual({ ok: false, reason: 'invalid' });
});

const search = { profile: 'search' } as const;
const searchPositionResult: ListCursorResult = { ok: true, epoch: position.epoch, after: [...position.after] };

test('list cursor bounds publish frozen limits for both profiles', () => {
  expect(LIST_CURSOR_BOUNDS).toEqual({
    default: {
      maxAfterKeys: 8,
      maxKeyBytes: 256,
      maxAfterBytes: 2_048,
      maxPlaintextBytes: 3_038,
      maxTokenLength: 4_096,
    },
    search: {
      maxAfterKeys: 8,
      maxKeyBytes: 2_560,
      maxAfterBytes: 3_072,
      maxPlaintextBytes: 3_584,
      maxTokenLength: 4_864,
    },
  });
  for (const value of [LIST_CURSOR_BOUNDS, ...Object.values(LIST_CURSOR_BOUNDS)])
    expect(Object.isFrozen(value)).toBe(true);
});

function searchData(bound: ListCursorBinding): Buffer {
  const query = Object.fromEntries(Object.entries(bound.query).sort(([a], [b]) => a.localeCompare(b)));
  return Buffer.from(
    JSON.stringify([
      'list-cursor',
      1,
      1,
      bound.route,
      bound.viewer === null ? 'anonymous' : 'account',
      bound.viewer,
      JSON.stringify(query),
      'search',
    ]),
  );
}

// Construct authenticated payloads independently so decode bounds cannot be hidden by encode validation.
function handmadeSearchCursor(bound: ListCursorBinding, payload: unknown): string {
  const salt = Buffer.alloc(16, 3);
  const material = Buffer.from(hkdfSync('sha256', key(1), salt, 'rezics/list-cursor/v1', 44));
  const cipher = createCipheriv('aes-256-gcm', material.subarray(0, 32), material.subarray(32));
  cipher.setAAD(searchData(bound));
  return Buffer.concat([
    Buffer.from([1, 1]),
    salt,
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64url');
}

test('a search cursor round-trips Unicode after-keys up to 2560 bytes each and 3072 bytes in total', async () => {
  const cjk = '界'.repeat(852) + '😀';
  const emoji = '😀'.repeat(128);
  expect(Buffer.byteLength(cjk)).toBe(2_560);
  expect(Buffer.byteLength(emoji)).toBe(512);
  const p = { epoch: 7, after: [cjk, emoji, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0, -1, '', ''] };
  for (const viewer of [null, viewerId]) {
    const bound = { ...binding, viewer };
    const token = await encodeListCursor(ring, bound, p, now, search);
    expect(token.length).toBeLessThanOrEqual(4_864);
    expect(await decodeListCursor(ring, bound, token, now, search)).toEqual({ ok: true, ...p });
    expect(
      await decodeListCursor(
        ring,
        bound,
        handmadeSearchCursor(bound, { e: 7, a: p.after, t: now.getTime() }),
        now,
        search,
      ),
    ).toEqual({ ok: true, ...p });
    expect(Buffer.from(token, 'base64url').includes(Buffer.from(cjk))).toBe(false);
  }
});

test('a search cursor above its per-key total or plaintext bound is refused at encode and decodes as invalid', async () => {
  const invalid: ListCursorResult = { ok: false, reason: 'invalid' };
  for (const viewer of [null, viewerId]) {
    const bound = { ...binding, viewer };
    const payload = { e: 7, a: [''], t: now.getTime() };
    // JSON escaping can exceed the plaintext cap while the raw key stays well within its byte cap.
    const room = 3_584 - Buffer.byteLength(JSON.stringify(payload));
    const atLimit = '\0'.repeat(Math.floor(room / 6)) + 'x'.repeat(room % 6);
    payload.a = [atLimit];
    expect(Buffer.byteLength(JSON.stringify(payload))).toBe(3_584);
    const p = { epoch: 7, after: payload.a };
    const token = await encodeListCursor(ring, bound, p, now, search);
    expect(token.length).toBe(4_824);
    expect(await decodeListCursor(ring, bound, token, now, search)).toEqual({ ok: true, ...p });
    expect(await decodeListCursor(ring, bound, handmadeSearchCursor(bound, payload), now, search)).toEqual({
      ok: true,
      ...p,
    });

    for (const after of [
      ['界'.repeat(852) + '😀x'], // 2,561 UTF-8 bytes in one key.
      ['😀'.repeat(128), '界'.repeat(852) + '😀', 'x'], // 3,073 bytes in total.
      [atLimit + 'x'], // 3,585 bytes of plaintext.
      Array.from({ length: 9 }, () => ''),
      [Number.MAX_SAFE_INTEGER + 1],
      [1.5],
    ]) {
      await expect(encodeListCursor(ring, bound, { epoch: 7, after }, now, search)).rejects.toThrow(TypeError);
      const forged = handmadeSearchCursor(bound, { e: 7, a: after, t: now.getTime() });
      expect(forged.length).toBeLessThanOrEqual(4_864);
      expect(await decodeListCursor(ring, bound, forged, now, search)).toEqual(invalid);
    }
    for (const other of [
      { ...bound, route: '界'.repeat(85) + 'xx' },
      { ...bound, query: { q: '😀'.repeat(510) + 'x' } },
    ]) {
      await expect(encodeListCursor(ring, other, position, now, search)).rejects.toThrow(TypeError);
      expect(await decodeListCursor(ring, other, token, now, search)).toEqual(invalid);
    }
    // An unusable ring must never be consulted for an oversized token.
    let keyLookups = 0;
    const unreadableRing = {
      current: 1,
      get keys(): KeyRing['keys'] {
        keyLookups += 1;
        throw new Error('Unexpected key lookup');
      },
    };
    const oversized = Buffer.concat([Buffer.from([1, 1]), Buffer.alloc(3_646)]).toString('base64url') + 'A';
    expect(oversized.length).toBe(4_865);
    expect(await decodeListCursor(unreadableRing, bound, oversized, now, search)).toEqual(invalid);
    expect(keyLookups).toBe(0);
    expect(await decodeListCursor(unreadableRing, bound, oversized.slice(0, -1), now, search)).toEqual(invalid);
    expect(keyLookups).toBe(1);
  }
});

test('an anonymous search cursor carries its issue time differs on each encode and expires after 15 minutes', async () => {
  for (const viewer of [null, viewerId]) {
    const bound = { ...binding, viewer };
    const token = await encodeListCursor(ring, bound, position, now, search);
    const again = await encodeListCursor(ring, bound, position, now, search);
    expect(again).not.toBe(token);
    const bytes = Buffer.from(token, 'base64url');
    expect(Buffer.from(again, 'base64url').subarray(2, 18)).not.toEqual(bytes.subarray(2, 18));
    const material = Buffer.from(hkdfSync('sha256', key(1), bytes.subarray(2, 18), 'rezics/list-cursor/v1', 44));
    const decipher = createDecipheriv('aes-256-gcm', material.subarray(0, 32), material.subarray(32));
    decipher.setAAD(searchData(bound));
    decipher.setAuthTag(bytes.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(18, -16)), decipher.final()]);
    expect(JSON.parse(plaintext.toString())).toEqual({ e: position.epoch, a: position.after, t: now.getTime() });
    for (const elapsed of [0, 15 * 60_000])
      expect(await decodeListCursor(ring, bound, token, later(elapsed), search)).toEqual(searchPositionResult);
    expect(await decodeListCursor(ring, bound, token, later(15 * 60_000 + 1), search)).toEqual({
      ok: false,
      reason: 'expired',
    });
    const fresh = await encodeListCursor(ring, bound, position, later(15 * 60_000 + 1), search);
    expect(await decodeListCursor(ring, bound, fresh, later(15 * 60_000 + 1), search)).toEqual(searchPositionResult);
    for (const t of [undefined, 'invalid', 1.5])
      expect(await decodeListCursor(ring, bound, handmadeSearchCursor(bound, { e: 7, a: [], t }), now, search)).toEqual(
        { ok: false, reason: 'invalid' },
      );
  }
});

test('a search cursor issued more than 60 seconds ahead decodes as invalid', async () => {
  for (const viewer of [null, viewerId]) {
    const bound = { ...binding, viewer };
    for (const lead of [60_000, 60_001]) {
      const token = await encodeListCursor(ring, bound, position, later(lead), search);
      expect(await decodeListCursor(ring, bound, token, now, search)).toEqual(
        lead === 60_000 ? searchPositionResult : { ok: false, reason: 'invalid' },
      );
    }
  }
});

test('a search cursor never decodes under the default profile and a default cursor never decodes under the search profile', async () => {
  for (const viewer of [null, viewerId]) {
    const bound = { ...binding, viewer };
    const token = await encodeListCursor(ring, bound, position, now, search);
    for (const defaults of [undefined, {}, { profile: 'default' } as const]) {
      expect(await decodeListCursor(ring, bound, token, now, defaults)).toEqual({ ok: false, reason: 'invalid' });
      const defaultToken = await encodeListCursor(ring, bound, position, now, defaults);
      expect(await decodeListCursor(ring, bound, defaultToken, now, search)).toEqual({ ok: false, reason: 'invalid' });
      expect(await decodeListCursor(ring, bound, defaultToken, now, { profile: 'default' })).toEqual(
        searchPositionResult,
      );
    }
  }
});
