import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { SeedApiError, type SeedApi } from './api.ts';
import { convergeRelease, grantSeedAuthority, releaseFacts } from './franchises-step.ts';
import type { LocalOperatorInput } from './operator.ts';

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

const seedActor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000009';
const seedInput = {
  endpoints: { account: 'http://127.0.0.1:9' },
  accessDatabaseUrl: 'postgres://127.0.0.1:5432/access',
  ownerAccountSubject: 'owner-account',
  actingSubject: seedActor,
} as LocalOperatorInput;
const eightHourGrant = "INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '8 hours')";
const eightHourRepresentation = "INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,clock_timestamp() + interval '8 hours')";

function seedAuthorityClient(options: { recovery?: boolean; open?: boolean; dispatch?: boolean } = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const grants = new Map<string, string>();
  const representations = new Map<string, string>();
  let principalId: string | undefined;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      const rows = (found: Record<string, unknown>[] = []) => ({ rows: found, rowCount: found.length });
      if (sql.includes('FROM access.recovery_fence')) return rows([{ open: options.recovery !== false }]);
      if (sql.includes('FROM access.principal')) return rows(principalId ? [{ id: principalId }] : []);
      if (sql.startsWith('INSERT INTO access.principal')) {
        principalId = String(values[0]);
        return rows();
      }
      if (sql.includes('FROM access.scope_gate')) {
        return rows([{ open: options.open !== false, dispatch_open: options.dispatch !== false }]);
      }
      if (sql.includes('FROM access.representation')) {
        const id = representations.get(`${values[0]}:${values[2]}`);
        return rows(id ? [{ id }] : []);
      }
      if (sql.startsWith('INSERT INTO access.representation')) {
        representations.set(`${values[1]}:${values[3]}`, String(values[0]));
        return rows();
      }
      if (sql.includes('FROM access.permission_grant')) {
        const id = grants.get(`${values[0]}:${values[1]}:${values[2]}`);
        return rows(id ? [{ id }] : []);
      }
      if (sql.startsWith('INSERT INTO access.permission_grant')) {
        grants.set(`${values[1]}:${values[2]}:${values[3]}`, String(values[0]));
        return rows();
      }
      return rows();
    },
    release() {},
  };
  return { calls, pool: { connect: async () => client } as unknown as Pool };
}

test('franchise seed writes an eight-hour self-grant and a retry keeps that row', async () => {
  const first = seedAuthorityClient();
  await grantSeedAuthority(first.pool, seedInput, 'semantic:create:root', 'semantic.change');
  const grant = first.calls.find(call => call.sql.startsWith('INSERT INTO access.permission_grant'));
  const representation = first.calls.find(call => call.sql.startsWith('INSERT INTO access.representation'));
  expect(grant?.sql).toBe(eightHourGrant);
  expect(grant?.values[1]).toBe(seedActor);
  expect(grant?.values[2]).toBe('semantic:create:root');
  expect(grant?.values[3]).toBe('semantic.change');
  expect(representation?.sql).toBe(eightHourRepresentation);
  expect(representation?.values[2]).toBe(seedActor);
  expect(representation?.values[3]).toBe('semantic.change');
  const before = first.calls.filter(call => call.sql.startsWith('INSERT INTO access.permission_grant')
    || call.sql.startsWith('INSERT INTO access.representation')).length;
  await grantSeedAuthority(first.pool, seedInput, 'semantic:create:root', 'semantic.change');
  const after = first.calls.filter(call => call.sql.startsWith('INSERT INTO access.permission_grant')
    || call.sql.startsWith('INSERT INTO access.representation')).length;
  expect(after).toBe(before);
});

test('a closed franchise gate refuses before a grant, including when only dispatch is open', async () => {
  const closed = seedAuthorityClient({ open: false, dispatch: true });
  await expect(grantSeedAuthority(closed.pool, seedInput, 'semantic:create:root', 'semantic.change'))
    .rejects.toMatchObject({ name: 'FixtureAuthorityDenied', kind: 'gate',
      message: 'fixture scope is closed: semantic:create:root' });
  expect(closed.calls.some(call => call.sql.startsWith('INSERT INTO access.permission_grant')
    || call.sql.startsWith('INSERT INTO access.representation'))).toBe(false);
  expect(closed.calls.at(-1)?.sql).toBe('ROLLBACK');
  const held = seedAuthorityClient({ recovery: false });
  await expect(grantSeedAuthority(held.pool, seedInput, 'semantic:create:root', 'semantic.change'))
    .rejects.toMatchObject({ name: 'FixtureAuthorityDenied', kind: 'recovery',
      message: 'Access recovery fence is closed' });
  expect(held.calls.some(call => call.sql.startsWith('INSERT INTO access.permission_grant')
    || call.sql.startsWith('INSERT INTO access.representation')
    || call.sql.includes('INSERT INTO access.scope_gate'))).toBe(false);
  expect(held.calls.at(-1)?.sql).toBe('ROLLBACK');
  const dispatchHeld = seedAuthorityClient({ open: true, dispatch: false });
  await grantSeedAuthority(dispatchHeld.pool, seedInput, 'semantic:create:root', 'semantic.change');
  expect(dispatchHeld.calls.some(call => call.sql.startsWith('INSERT INTO access.permission_grant'))).toBe(true);
});

test('release facts ignore read-only fields and the order of identifiers and coverage', () => {
  expect(releaseFacts(stored())).toEqual(releaseFacts(planned));
  expect(releaseFacts(stored({ isbn13: null }))).not.toEqual(releaseFacts(planned));
});
