import { expect, test } from 'bun:test';
import { SeedApiError, type SeedApi } from './api.ts';
import { convergeRelease, releaseFacts } from './franchises-step.ts';

const uuid = '00000000-0000-4000-a000-000000000001';
const native = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-a000-${suffix.padStart(12, '0')}`;
const path = `/v1/works/${uuid}/releases/${uuid}`;
const realization = native('a1');
const planned = { profile: 'release-v2', id: native('1'), expectedHead: null, actingSubject: native('9'), kind: 'formal',
  status: 'official', titleLanguage: 'ja', tracklistLanguage: null, title: { value: 'Sword Art Online 1', language: 'ja' },
  editionStatement: null, publisher: 'Hunan Fine Arts', publicationYear: null, isbn13: '9780000000019',
  originalUrl: null, fixedRelease: null, identifiers: [{ provider: 'https://a.example', value: '1' },
    { provider: 'https://b.example', value: '2' }], platform: null, territory: null, evidence: null,
  coverage: [{ realization, revision: native('b1'), completeness: 'complete' as const }] };
/** What the public read returns for a stored release: derived fields and Work context included. */
const stored = (overrides: Record<string, unknown> = {}) => ({ ...planned, expectedHead: undefined, actingSubject: undefined,
  evidence: undefined, revision: native('c1'), contentLanguages: ['ja'], isTranslation: false, originalLanguages: [],
  legacyCoverage: null, snapshots: [], sourcePosition: { dataEpoch: 'e', sequence: '1' },
  identifiers: [...planned.identifiers].reverse(),
  coverage: planned.coverage.map(row => ({ ...row, work: native('d1'), mainVersion: native('d2'), language: 'ja' })),
  ...overrides });

function fixture(current: unknown | 404) {
  const puts: { path: string; body: Record<string, unknown>; key: string }[] = [];
  let matched = 0;
  const api = {
    get: async () => {
      if (current === 404) throw new SeedApiError('release', 404, '{}');
      return current;
    },
    put: async (target: string, body: Record<string, unknown>, _token: string, key: string) => {
      puts.push({ path: target, body, key });
      return { work: native('d1'), release: planned.id, revision: native('c2'), replayed: false };
    },
  } as unknown as SeedApi;
  return { api, puts, matched: () => matched, run: () => convergeRelease(api, 'token', path, planned, 'catalogue:v1:release:x', () => { matched++; }) };
}

test('a release the plan already matches sends no write, whatever order the read lists its rows', async () => {
  const run = fixture(stored());
  const response = await run.run();
  expect(run.puts).toEqual([]);
  expect(run.matched()).toBe(1);
  expect(response).toEqual({ status: 200, body: { work: native('1').replace(/.{36}$/, uuid), release: planned.id,
    revision: native('c1'), replayed: true } });
});

test('a closed release the plan changes is corrected against its head with evidence, under a body-bound key', async () => {
  const run = fixture(stored({ isbn13: null }));
  const response = await run.run();
  expect(run.puts).toHaveLength(1);
  expect(run.puts[0]!.body).toEqual({ ...planned, expectedHead: native('c1'), evidence: realization });
  expect(run.puts[0]!.key).toMatch(/^catalogue:v1:release:x:correction:[0-9a-f]{24}$/);
  expect(response?.body).toMatchObject({ revision: native('c2') });
  expect(run.matched()).toBe(0);
  // The same plan against the same head replays its own correction; a later head is a new correction.
  const again = fixture(stored({ isbn13: null }));
  await again.run();
  expect(again.puts[0]!.key).toBe(run.puts[0]!.key);
  const other = fixture(stored({ isbn13: null, revision: native('c9') }));
  await other.run();
  expect(other.puts[0]!.key).not.toBe(run.puts[0]!.key);
});

test('a release moved to another realization revision is a change, not a match', async () => {
  const moved = stored();
  moved.coverage = moved.coverage.map(row => ({ ...row, revision: native('b2') }));
  const run = fixture(moved);
  await run.run();
  expect(run.puts).toHaveLength(1);
});

test('a release with no public read is left to the create that follows', async () => {
  const run = fixture(404);
  expect(await run.run()).toBeNull();
  expect(run.puts).toEqual([]);
});

test('release facts ignore read-only fields and the order of identifiers and coverage', () => {
  expect(releaseFacts(stored())).toEqual(releaseFacts(planned));
  expect(releaseFacts(stored({ isbn13: null }))).not.toEqual(releaseFacts(planned));
});
