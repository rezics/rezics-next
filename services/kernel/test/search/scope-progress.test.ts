import { expect, test } from 'bun:test';
import { FILTER_LIMITS } from '@rezics/filter';
import {
  packScopeLeafProgress as pack,
  unpackScopeLeafProgress as unpack,
  type ScopeLeafPosition,
  type ScopeLeafLimits,
} from '../../src/search/scope-progress.ts';
import { encodeListCursor, decodeListCursor } from '../../src/tokens/list-cursor.ts';

const limits = Object.freeze({ valueCounts: Object.freeze(Array(FILTER_LIMITS.leaves).fill(FILTER_LIMITS.in)) });
const nil = '00000000-0000-0000-0000-000000000000';
const uuid = 'fedcba98-7654-3210-fedc-ba9876543210';
const invalid = { ok: false, reason: 'invalid' } as const;
const position = (
  phase: NonNullable<ScopeLeafPosition>['phase'],
  after: string | null,
): NonNullable<ScopeLeafPosition> => ({ leafOrdinal: 31, phase, valueOrdinal: 63, after });
const wire = (version: number, phase: number, payload = Buffer.alloc(16)) =>
  Buffer.concat([Buffer.from([(version << 5) | 31, (phase << 6) | 63]), payload]).toString('base64url');

test('the agreed bounded native leaf progress record is specified inside the existing cursor position', async () => {
  const sourceAfter = pack(position('witness', uuid), limits);
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) };
  const binding = { route: 'scope', viewer: uuid, query: { q: 'current' } };
  const now = new Date('2026-10-28T00:00:00Z');
  const after = ['basis', uuid, uuid, 0, uuid, sourceAfter, 'owner-basis', 1];
  const token = await encodeListCursor(ring, binding, { epoch: 1, after }, now);
  const decoded = await decodeListCursor(ring, binding, token, now);
  expect(decoded).toEqual({ ok: true, epoch: 1, after });
  if (!decoded.ok) throw new Error('Cursor roundtrip failed');
  expect(unpack(decoded.after[5], limits)).toEqual({ ok: true, position: position('witness', uuid) });
});

test('whole null, pending witness start and real nil UUID are distinct canonical records', () => {
  expect(pack(null, limits)).toBe('');
  expect(unpack('', limits)).toEqual({ ok: true, position: null });
  expect(unpack('', { valueCounts: [] })).toEqual({ ok: true, position: null });
  for (const [after, phase] of [
    [null, 3],
    [nil, 2],
    [uuid, 2],
  ] as const) {
    const record = pack(position('witness', after), limits);
    expect(record).toHaveLength(24);
    expect(record).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const bytes = Buffer.from(record, 'base64url');
    expect(bytes).toHaveLength(18);
    expect(bytes[0]).toBe(63);
    expect(bytes[1]).toBe((phase << 6) | 63);
    expect(bytes.subarray(2).toString('hex')).toBe((after ?? nil).replaceAll('-', ''));
    expect(unpack(record, limits)).toEqual({ ok: true, position: position('witness', after) });
  }
});

test('compact and selection preserve null, zero, unsafe Number integers and maximum u64 minus two exactly', () => {
  for (const phase of ['compact', 'selection'] as const) {
    for (const after of [null, '0', '1', '9007199254740993', '18446744073709551614']) {
      const record = pack(position(phase, after), limits);
      const bytes = Buffer.from(record, 'base64url');
      expect(bytes[1]).toBe((phase === 'compact' ? 0 : 64) | 63);
      expect(bytes.subarray(2, 10).toString('hex')).toBe(
        (after === null ? 0n : BigInt(after) + 1n).toString(16).padStart(16, '0'),
      );
      expect(bytes.subarray(10)).toEqual(Buffer.alloc(8));
      expect(unpack(record, limits)).toEqual({ ok: true, position: position(phase, after) });
    }
    for (const after of [
      '18446744073709551615',
      '18446744073709551616',
      '-1',
      '-0',
      '00',
      '01',
      '+1',
      '1.0',
      '1e2',
      ' 1',
      '1\n',
      '',
      '١',
      '9'.repeat(100),
    ])
      expect(() => pack(position(phase, after), limits)).toThrow(TypeError);
  }
});

test('reject every wrong version, nonzero reserved payload and sequence padding byte', () => {
  for (let version = 0; version < 8; version++) {
    if (version !== 1)
      for (let phase = 0; phase < 4; phase++) expect(unpack(wire(version, phase), limits)).toEqual(invalid);
  }
  for (let index = 0; index < 16; index++) {
    const payload = Buffer.alloc(16);
    payload[index] = 1;
    expect(unpack(wire(1, 3, payload), limits)).toEqual(invalid);
    if (index >= 8) for (const phase of [0, 1]) expect(unpack(wire(1, phase, payload), limits)).toEqual(invalid);
  }
});

test('reject noncanonical base64, padding, lengths, alphabet and untrusted types without throwing', () => {
  const record = pack(position('witness', uuid), limits);
  for (const bad of [
    record + '=',
    record + '==',
    record.slice(1),
    record + 'A',
    ' ' + record,
    record + '\n',
    '+'.repeat(24),
    '/'.repeat(24),
    '='.repeat(24),
    Buffer.alloc(17).toString('base64url'),
    Buffer.alloc(19).toString('base64url'),
    null,
    undefined,
    1,
    true,
    [],
    {},
    Buffer.from(record),
    Symbol('record'),
  ])
    expect(unpack(bad, limits)).toEqual(invalid);
  // Eighteen bytes have no spare base64 bits; re-encoding every accepted spelling is exact.
  for (const phase of ['compact', 'selection', 'witness'] as const) {
    const record = pack(position(phase, phase === 'witness' ? uuid : '42'), limits);
    expect(Buffer.from(record, 'base64url').toString('base64url')).toBe(record);
  }
});

test('validate ordinals against current per-leaf counts, not just wire capacity', () => {
  const current = { valueCounts: [1, 2] };
  const first = { leafOrdinal: 0, valueOrdinal: 0, phase: 'compact', after: null } as const;
  expect(unpack(pack(first, current), current)).toEqual({ ok: true, position: first });
  for (const changes of [
    { leafOrdinal: -1 },
    { leafOrdinal: 32 },
    { leafOrdinal: 0.5 },
    { leafOrdinal: NaN },
    { leafOrdinal: Infinity },
    { leafOrdinal: '0' },
    { valueOrdinal: -1 },
    { valueOrdinal: 64 },
    { valueOrdinal: 0.5 },
    { valueOrdinal: NaN },
    { valueOrdinal: '0' },
  ])
    expect(() => pack({ ...first, ...changes } as ScopeLeafPosition, limits)).toThrow(TypeError);
  for (const leaf of [
    { ...first, leafOrdinal: 2 },
    { ...first, valueOrdinal: 1 },
    { ...first, leafOrdinal: 1, valueOrdinal: 2 },
  ]) {
    expect(() => pack(leaf, current)).toThrow(TypeError);
    expect(unpack(pack(leaf, limits), current)).toEqual(invalid);
  }
  expect(unpack(pack(first, limits), { valueCounts: [] })).toEqual(invalid);
});

test('invalid input types, phases, UUIDs and limits reject; input is never mutated', () => {
  for (const bad of [
    undefined,
    false,
    1,
    'position',
    [],
    {},
    { ...position('compact', null), phase: 'other' },
    ...[undefined, 1, 0n, false, {}].map((after) => ({ ...position('compact', null), after })),
  ])
    expect(() => pack(bad as ScopeLeafPosition, limits)).toThrow(TypeError);
  for (const after of [uuid.toUpperCase(), uuid.replaceAll('-', ''), '', '0', uuid + '0', uuid.replace('f', 'g')])
    expect(() => pack(position('witness', after), limits)).toThrow(TypeError);
  for (const bad of [
    null,
    undefined,
    {},
    { valueCounts: '1' },
    { valueCounts: Array(33).fill(1) },
    ...[0, -1, 65, 1.5, NaN, Infinity, '1', null, undefined].map((count) => ({ valueCounts: [count] })),
    { valueCounts: Array(1) },
  ]) {
    expect(() => pack(null, bad as ScopeLeafLimits)).toThrow(TypeError);
    expect(unpack('', bad as ScopeLeafLimits)).toEqual(invalid);
  }
  const frozen = Object.freeze(position('selection', '9007199254740993'));
  const before = structuredClone({ frozen, limits });
  expect(unpack(pack(frozen, limits), limits)).toEqual({ ok: true, position: frozen });
  expect({ frozen, limits }).toEqual(before);
});
