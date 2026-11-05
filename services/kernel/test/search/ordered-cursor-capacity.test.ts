import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalParameters } from '../../src/tokens/cursor.ts';
import {
  decodeListCursor,
  encodeListCursor,
  LIST_CURSOR_BOUNDS,
  type ListCursorBinding,
} from '../../src/tokens/list-cursor.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

// Reviewed proposal / serialization stress ONLY. These vectors adopt no ordered ABI, profile or TTL for Zone,
// satisfy no paired research decision, and establish no native ordering, normalization, writer coverage,
// alias/leaf liveness, membership or allow. Exact tag/ordinal semantics still require owner agreement.
const ring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const now = new Date('2026-10-28T00:00:00.000Z');
const at = (offset: number) => new Date(now.getTime() + offset);
const search = { profile: 'search' } as const;
const bounds = LIST_CURSOR_BOUNDS.search;
const account = '018f0000-0000-7000-8000-00a000000001';
const predecessor = '018f0000-0000-7000-8000-00a000000042';
const tiedSuccessor = '018f0000-0000-7000-8000-00a000000043';
const pending = '018f0000-0000-7000-8000-00a000000044';
const original = '018f0000-0000-7000-8000-00a000000045';
const fact = '018f0000-0000-7000-8000-00a000000046';
const basis = '0123456789abcdef'.repeat(4);
const ownerBasis = 'fedcba9876543210'.repeat(4);
// Fixed Search witness record per scope-progress.ts: version1/leaf31, witness/value31, original UUID.
// This is a raw 18-byte record, not an encrypted nested cursor or a cached truth/witness vector.
const leaf = Buffer.from(`3f9f${original.replaceAll('-', '')}`, 'hex').toString('base64url');
// Fixed Collection sourceAfter per library/canonical-source-store.ts: version1, output driver5, two UUIDs.
const collectionRecord = `1:5:${original}:${fact}`;
const searchOwner = `1:S:${ownerBasis}:${leaf}`;
const collectionOwner = `1:C:${ownerBasis}:${collectionRecord}`;
// Proposal explicitly budgets 16 reads (0..15), 32 sources (0..31), and a predicate lane IN this key.
// The predicate lane is not a free ninth field. These strings are examples, not a production ordinal parser.
const lastOrdinal = '1:15:31:predicate';
const firstOrdinal = '1:0:0:source';
const cjk250 = `s${'界'.repeat(250)}`;
const bmp512 = `s${'界'.repeat(512)}`;
// Conservative JSON escaping stress ONLY: no claim catalogue/native normalization admits this name.
const controls512 = `s${'\u0000'.repeat(512)}`;

// Exactly [basis,countTag,nameTag,idTag,pendingGroup,ownerOrdinal,aliasAfter,ownerRecord].
// Only ONE last SETTLED native tuple; pendingGroup is the FIRST unconsumed candidate, not another name tuple.
// Search aliasAfter replays the original first; Collection aliasAfter denotes its last settled alias.
type ProposedAfter = readonly [string, string, string, string, string, string, string, string];
const vectors: readonly { label: string; sort: string; after: ProposedAfter }[] = [
  { label: 'name start', sort: 'name', after: [basis, '', '', '', pending, firstOrdinal, original, searchOwner] },
  {
    label: 'name null',
    sort: 'name',
    after: [basis, '', 'z', `s${predecessor}`, pending, lastOrdinal, original, searchOwner],
  },
  {
    label: 'name native empty',
    sort: 'name',
    after: [basis, '', 's', `s${predecessor}`, pending, lastOrdinal, original, searchOwner],
  },
  {
    label: 'name legal 250 CJK',
    sort: 'name',
    after: [basis, '', cjk250, `s${predecessor}`, pending, lastOrdinal, original, searchOwner],
  },
  {
    label: 'name maximum BMP',
    sort: 'name',
    after: [basis, '', bmp512, `s${predecessor}`, pending, lastOrdinal, original, collectionOwner],
  },
  {
    label: 'collections start',
    sort: 'collections',
    after: [basis, '', '', '', pending, firstOrdinal, original, collectionOwner],
  },
  {
    label: 'collections zero null name',
    sort: 'collections',
    after: [basis, 'n0', 'z', `s${predecessor}`, pending, lastOrdinal, original, collectionOwner],
  },
  {
    label: 'collections zero empty name',
    sort: 'collections',
    after: [basis, 'n0', 's', `s${predecessor}`, pending, lastOrdinal, original, collectionOwner],
  },
  {
    label: 'collections maximum count and BMP',
    sort: 'collections',
    after: [basis, 'n2147483647', bmp512, `s${predecessor}`, pending, lastOrdinal, original, collectionOwner],
  },
  {
    label: 'collections unique UUID tie',
    sort: 'collections',
    after: [basis, 'n2147483647', bmp512, `s${tiedSuccessor}`, pending, lastOrdinal, original, searchOwner],
  },
  {
    label: 'name unique UUID tie',
    sort: 'name',
    after: [basis, '', bmp512, `s${tiedSuccessor}`, pending, lastOrdinal, original, searchOwner],
  },
  {
    label: 'collections control escaping stress',
    sort: 'collections',
    after: [basis, 'n2147483647', controls512, `s${predecessor}`, pending, lastOrdinal, original, collectionOwner],
  },
];
// This test request's stable body is exactly { sort, limit }; the cursor is excluded.
// No mutable server basis, configuration, release, index, identity or source enters this digest.
const binding = (viewer: string | null, sort: string, limit = 32, zoneId = fact): ListCursorBinding => ({
  route: 'POST /v1/zones/{id}:readPage',
  viewer,
  query: {
    zoneId,
    bodyDigest: createHash('sha256').update(canonicalParameters({ sort, limit })).digest('hex'),
  },
});

test('proposed eight split-field ordered positions roundtrip through the actual existing encrypted search profile within all byte ceilings', async () => {
  expect(bounds).toEqual({
    maxAfterKeys: 8,
    maxKeyBytes: 2560,
    maxAfterBytes: 3072,
    maxPlaintextBytes: 3584,
    maxTokenLength: 4864,
  });
  expect(Buffer.byteLength(cjk250)).toBe(751);
  expect(Buffer.byteLength(bmp512)).toBe(1537);
  expect(Buffer.from(leaf, 'base64url')).toHaveLength(18);
  expect(leaf).toMatch(/^[A-Za-z0-9_-]{24}$/);
  expect(Buffer.byteLength(collectionRecord)).toBe(77);
  expect(Buffer.byteLength(searchOwner)).toBe(93);
  expect(Buffer.byteLength(collectionOwner)).toBe(146);
  // Literal tags preserve null (z), native empty (s), and start (blank) separately, without a lossy parser.
  expect(new Set(vectors.slice(0, 3).map(({ after }) => after[2])).size).toBe(3);
  const measured = { key: 0, aggregate: 0, plaintext: 0, token: 0 };
  for (const { label, sort, after } of vectors) {
    const position = { epoch: Number.MAX_SAFE_INTEGER, after };
    expect(after.length, label).toBe(bounds.maxAfterKeys);
    const keyBytes = after.map((key) => Buffer.byteLength(key));
    measured.key = Math.max(measured.key, ...keyBytes);
    measured.aggregate = Math.max(
      measured.aggregate,
      keyBytes.reduce((sum, bytes) => sum + bytes, 0),
    );
    for (const bytes of keyBytes) expect(bytes, label).toBeLessThanOrEqual(bounds.maxKeyBytes);
    expect(
      keyBytes.reduce((sum, bytes) => sum + bytes, 0),
      label,
    ).toBeLessThanOrEqual(bounds.maxAfterBytes);
    // Exact timed JSON envelope inspected in tokens/list-cursor.ts, encodeListCursor. Plaintext is not exported.
    // Measure its UTF-8 JSON serialization (including escaping), NOT the base64 token length as plaintext.
    const plaintext = Buffer.from(JSON.stringify({ e: position.epoch, a: after, t: now.getTime() }));
    measured.plaintext = Math.max(measured.plaintext, plaintext.length);
    expect(plaintext.length, label).toBeLessThanOrEqual(bounds.maxPlaintextBytes);
    for (const viewer of [null, account]) {
      const bound = binding(viewer, sort);
      const token = await encodeListCursor(ring, bound, position, now, search);
      measured.token = Math.max(measured.token, token.length);
      expect(token.length, label).toBeLessThanOrEqual(bounds.maxTokenLength);
      // Actual envelope: 2-byte version/kid, 16-byte salt, AES-GCM ciphertext and 16-byte tag.
      expect(Buffer.from(token, 'base64url').length, label).toBe(plaintext.length + 34);
      const decoded = await decodeListCursor(ring, bound, token, now, search);
      expect(decoded, label).toEqual({ ok: true, epoch: position.epoch, after: [...after] });
      if (!decoded.ok) throw new Error(`Actual codec rejected ${label}`);
      expect(
        decoded.after.map((value) => Buffer.from(String(value))),
        label,
      ).toEqual(after.map((value) => Buffer.from(value)));
      expect(
        await decodeListCursor(ring, { ...bound, viewer: viewer === null ? account : null }, token, now, search),
      ).toEqual({ ok: false, reason: 'invalid' });
    }
  }
  // Observed maxima across the full vectors; the escaping stress determines plaintext/token maxima.
  expect(measured).toEqual({ key: 1537, aggregate: 1884, plaintext: 3490, token: 4699 });
});

test('actual codec binds only stable readPage route viewer Zone and body shape while encrypted dynamic basis is compared after decode', async () => {
  const position = { epoch: 1, after: [...vectors[8]!.after] };
  const freshBasis = ownerBasis;
  for (const viewer of [null, account]) {
    const bound = binding(viewer, 'collections');
    expect(bound).toEqual({
      route: 'POST /v1/zones/{id}:readPage',
      viewer,
      query: {
        zoneId: fact,
        bodyDigest: createHash('sha256').update('{"limit":32,"sort":"collections"}').digest('hex'),
      },
    });
    const token = await encodeListCursor(ring, bound, position, now, search);
    // Rebuild the same stable request after observing a different current basis.
    const decoded = await decodeListCursor(ring, binding(viewer, 'collections'), token, now, search);
    expect(decoded).toEqual({ ok: true, ...position });
    if (!decoded.ok) throw new Error('Actual codec rejected the unchanged stable request');
    expect(decoded.after[0]).toBe(basis);
    expect(decoded.after[0] === freshBasis).toBe(false);
    // Unit comparison evidence only: no implemented Zone route or current authorization/readiness/liveness proof.
    // Route policy for any unusable valid-shaped cursor requires fresh CURRENT authorization and 202 or 200.
    for (const changed of [
      { ...bound, route: 'POST /v1/zones/:zoneId/readPage' },
      binding(viewer === null ? account : null, 'collections'),
      binding(viewer, 'collections', 32, pending),
      binding(viewer, 'name'),
      binding(viewer, 'collections', 33),
    ]) {
      expect(await decodeListCursor(ring, changed, token, now, search)).toEqual({ ok: false, reason: 'invalid' });
    }
  }
});

test('native codec errors remain explicit for overbound keys, aggregate, ninth key and escaped plaintext', async () => {
  const bound = binding(null, 'collections');
  const after = vectors[vectors.length - 1]!.after;
  for (const overflow of [
    ['x'.repeat(bounds.maxKeyBytes + 1), ...after.slice(1)],
    ['x'.repeat(1537), 'y'.repeat(1536), ...after.slice(2)],
    [...after, 'ninth'],
  ]) {
    await expect(encodeListCursor(ring, bound, { epoch: 1, after: overflow }, now, search)).rejects.toThrow(
      'Invalid list cursor position',
    );
  }
  // All string/key ceilings still fit; only JSON's control escaping exceeds the plaintext ceiling.
  const escaped = [...after];
  escaped[2] = `s${'\u0000'.repeat(550)}`;
  expect(escaped.every((key) => Buffer.byteLength(key) <= bounds.maxKeyBytes)).toBe(true);
  expect(escaped.reduce((sum, key) => sum + Buffer.byteLength(key), 0)).toBeLessThanOrEqual(bounds.maxAfterBytes);
  expect(Buffer.byteLength(JSON.stringify({ e: 1, a: escaped, t: now.getTime() }))).toBeGreaterThan(
    bounds.maxPlaintextBytes,
  );
  await expect(encodeListCursor(ring, bound, { epoch: 1, after: escaped }, now, search)).rejects.toThrow(
    'The list cursor position is too long',
  );
});

test('default key bounds and cross-profile isolation remain unchanged', async () => {
  for (const viewer of [null, account]) {
    const bound = binding(viewer, 'name');
    const position = { epoch: 1, after: ['x'.repeat(257)] };
    await expect(encodeListCursor(ring, bound, position, now)).rejects.toThrow('Invalid list cursor position');
    const small = { epoch: 1, after: ['z'] };
    const token = await encodeListCursor(ring, bound, small, now, search);
    expect(await decodeListCursor(ring, bound, token, now)).toEqual({ ok: false, reason: 'invalid' });
    const defaultToken = await encodeListCursor(ring, bound, small, now);
    expect(await decodeListCursor(ring, bound, defaultToken, now, search)).toEqual({ ok: false, reason: 'invalid' });
  }
});

test('search profile keeps actual fifteen-minute expiry and sixty-second future skew for null anonymous and account UUID viewers', async () => {
  const position = { epoch: 1, after: [...vectors[8]!.after] };
  for (const viewer of [null, account]) {
    const bound = binding(viewer, 'collections');
    const token = await encodeListCursor(ring, bound, position, now, search);
    expect(await decodeListCursor(ring, bound, token, at(900_000), search)).toEqual({ ok: true, ...position });
    expect(await decodeListCursor(ring, bound, token, at(900_001), search)).toEqual({ ok: false, reason: 'expired' });
    expect(await decodeListCursor(ring, bound, token, at(-60_000), search)).toEqual({ ok: true, ...position });
    expect(await decodeListCursor(ring, bound, token, at(-60_001), search)).toEqual({ ok: false, reason: 'invalid' });
  }
});
