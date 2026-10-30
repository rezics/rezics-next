import { expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import {
  decodeDiscoveryCursor,
  discoveryDescription,
  discoveryLimit,
  discoveryWindow,
  encodeDiscoveryCursor,
  type DiscoveryCursorContext,
} from '../../src/community/discovery.ts';
import { discoveryQuerySchema, discoveryResponseSchema } from '../../src/community/schemas.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { newId } from '../../src/route/route.ts';

const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(51)]]) };
const now = Date.parse('2026-10-31T12:00:00.000Z');
const context: DiscoveryCursorContext = {
  sort: 'popular',
  cutoff: '2026-10-31',
  partitionEpoch: 2,
  publicationEpoch: 'publication-generation',
};

test('Popular and Trending use complete UTC days across month and leap-day boundaries', () => {
  // The offset is already March locally, but the current UTC day is still February 29.
  const at = new Date('2024-03-01T01:00:00+08:00');
  expect(discoveryWindow('popular', at)).toEqual({ from: '2024-01-30', cutoff: '2024-02-29' });
  expect(discoveryWindow('trending', at)).toEqual({ from: '2024-02-28', cutoff: '2024-02-29' });
  expect(discoveryWindow('popular', new Date('2026-10-31T23:59:59.999Z'))).toEqual({
    from: '2026-10-01',
    cutoff: '2026-10-31',
  });
  expect(discoveryWindow('trending', new Date('2026-11-01T00:00:00.000Z'))).toEqual({
    from: '2026-10-31',
    cutoff: '2026-11-01',
  });
  expect(() => discoveryWindow('popular', new Date(NaN))).toThrow(TypeError);
});

test('discovery accepts standard limits while bounding examined candidates to twenty', () => {
  const query = Compile(discoveryQuerySchema);
  expect(query.Check({ sort: 'popular' })).toBe(true);
  expect(query.Check({ sort: 'trending', limit: 100 })).toBe(true);
  expect(discoveryLimit()).toEqual({ limit: 20, candidates: 20 });
  expect(discoveryLimit(1)).toEqual({ limit: 1, candidates: 1 });
  expect(discoveryLimit(100)).toEqual({ limit: 100, candidates: 20 });
  for (const limit of [0, 101, 1.5, NaN]) {
    expect(() => discoveryLimit(limit)).toThrow(ProblemError);
    expect(query.Check({ sort: 'popular', limit })).toBe(false);
  }
  expect(query.Check({ sort: 'recent' })).toBe(false);
  expect(query.Check({ sort: 'popular', accountId: newId(1) })).toBe(false);
});

test('signed continuation retains the last examined rank and rejects changed query or stale generations', () => {
  const position = { count: '9007199254740993', realmId: newId(0x1234) };
  const cursor = encodeDiscoveryCursor(tokens, context, position, now);
  // This same continuation is usable for a sparse or empty page: visible output is not its position.
  expect(decodeDiscoveryCursor(tokens, { ...context, limit: 20 }, cursor, now)).toEqual(position);
  for (const current of [
    { ...context, cutoff: '2026-11-01' },
    { ...context, partitionEpoch: 3 },
    { ...context, publicationEpoch: 'next-publication-generation' },
  ]) {
    expect(() => decodeDiscoveryCursor(tokens, current, cursor, now)).toThrow(
      expect.objectContaining({ code: 'stale_cursor' }),
    );
  }
  for (const current of [
    { ...context, sort: 'trending' as const },
    { ...context, limit: 100 },
  ]) {
    expect(() => decodeDiscoveryCursor(tokens, current, cursor, now)).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  }
  for (const invalid of [position.realmId, `${cursor.slice(0, -1)}!`]) {
    expect(() => decodeDiscoveryCursor(tokens, context, invalid, now)).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  }
  expect(() => encodeDiscoveryCursor(tokens, context, { ...position, count: '0' }, now)).toThrow(TypeError);
});

test('discovery summaries collapse whitespace and truncate Unicode characters with an unavailable avatar', () => {
  expect(discoveryDescription(' \n A\t\tcommunity\u2003summary \r ')).toBe('A community summary');
  expect(discoveryDescription('😀'.repeat(161))).toBe('😀'.repeat(160));
  const card = {
    realmId: newId(0x1234),
    spaceId: newId(0x1234),
    name: 'A Realm',
    description: discoveryDescription(' A summary '),
    avatar: null,
  };
  const response = Compile(discoveryResponseSchema);
  expect(response.Check({ realms: [card], next: null })).toBe(true);
  expect(response.Check({ realms: [], next: 'signed-continuation' })).toBe(true);
  expect(response.Check({ items: [card], next: null })).toBe(false);
  expect(response.Check({ realms: [{ ...card, avatar: 'https://example.com/avatar' }], next: null })).toBe(false);
  for (const extra of [{ count: 1 }, { score: 1 }, { accountId: newId(1) }]) {
    expect(response.Check({ realms: [{ ...card, ...extra }], next: null })).toBe(false);
  }
});
