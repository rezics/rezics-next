import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import { createSemanticDriver } from './outcome-driver.ts';

let fixture: ReleasedDiscoveryFixture;
let book: string;
let activeState: string;
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture();
  const type = fixture.release.definition.types['schema:Book']!;
  const profile = fixture.release.definition.libraryProfiles![type.library!.profileId]!;
  activeState = profile.entryStateSet!.states.find((state) => state.role === 'active')!.id;
  expect(profile.id).toBe('book.reading');
  book = (await fixture.createSubject('schema:Book', 'Native capability control')).id;
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response.body;
}
function problem(response: HttpResponse, expected: number, code: string) {
  status(response, expected);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({ status: expected, code });
}
async function openings() {
  return (
    await fixture.inspect<{ group: string }>(
      'SELECT "group" FROM access.exposure_opening WHERE valid @> clock_timestamp() ORDER BY "group"',
    )
  ).rows.map((row) => row.group);
}
async function entryRows() {
  return (
    await fixture.inspect('SELECT * FROM library.entry WHERE account_id = $1 AND subject_id = $2', [
      fixture.personas.alice.accountId,
      book,
    ])
  ).rows;
}

test('shared discovery setup opens only explicitly requested native library and progress gates through real governor', async () => {
  const initial = await openings();
  expect(initial).toEqual(['collections']);
  problem(await fixture.request('alice', 'GET', `/v1/libraryEntries/${book}`), 403, 'platform_closed');
  const progress = { subjectId: book, mode: 'scalar_amount', unit: 'page', total: '20' };
  problem(
    await fixture.request('alice', 'POST', '/v1/progressSessions', progress, discoveryKey()),
    403,
    'platform_closed',
  );
  // Validate the entire closed request before any mutation, including untyped callers.
  await expect(fixture.setup.openFeatures(['personal_library', 'commerce' as 'personal_library'])).rejects.toThrow();
  expect(await openings()).toEqual(initial);
  await fixture.setup.openFeatures(['personal_library']);
  expect(await openings()).toEqual(['collections', 'personal_library']);
  status(
    await fixture.request('alice', 'PUT', `/v1/libraryEntries/${book}`, { state: activeState }, discoveryKey()),
    201,
  );
  status(await fixture.request('alice', 'GET', `/v1/libraryEntries/${book}`), 200);
  problem(
    await fixture.request('alice', 'POST', '/v1/progressSessions', progress, discoveryKey()),
    403,
    'platform_closed',
  );
  await fixture.setup.openFeatures(['reading_progress']);
  await fixture.setup.openFeatures(['reading_progress']);
  expect(await openings()).toEqual(['collections', 'personal_library', 'reading_progress']);
  const created = status(await fixture.request('alice', 'POST', '/v1/progressSessions', progress, discoveryKey()), 201);
  const session = created.progressSession as { id: string; revision: number };
  const path = `/v1/progressSessions/${session.id}`;
  status(
    await fixture.request(
      'alice',
      'POST',
      `${path}:record`,
      { revision: session.revision, amount: '3' },
      discoveryKey(),
    ),
    200,
  );
  expect(status(await fixture.request('alice', 'GET', path), 200).progressSession).toMatchObject({
    amount: '3',
    unit: 'page',
  });
  const stored = await fixture.inspect(
    'SELECT account_id, subject_id, mode, unit, amount FROM library.progress_session WHERE session_id = $1',
    [session.id],
  );
  expect(stored.rows).toEqual([
    {
      account_id: fixture.personas.alice.accountId,
      subject_id: book,
      mode: 'scalar_amount',
      unit: 'page',
      amount: '3',
    },
  ]);
  problem(await fixture.request('bob', 'GET', path), 404, 'not_found');
  const gates = await fixture.inspect(
    "SELECT action FROM access.resource_grant WHERE subject_id = ANY($1::uuid[]) AND action LIKE 'gate:%'",
    [[fixture.personas.alice.accountId, fixture.personas.bob.accountId]],
  );
  expect(gates.rows).toEqual([]);
}, 120_000);

test('scoped readonly Alice bearer uses the same native account and cannot write while real fullscope Alice can', async () => {
  const original = { ...fixture.personas.alice };
  const readonlyAlice = await fixture.scoped('alice', ['library_entry:read']);
  expect(readonlyAlice.accountId).toBe(original.accountId);
  const path = `/v1/libraryEntries/${book}`;
  expect(status(await readonlyAlice.request('GET', path), 200).libraryEntry).toMatchObject({
    subjectId: book,
    state: activeState,
  });
  const before = await entryRows();
  const revision = (before[0] as { revision: number }).revision;
  problem(await readonlyAlice.request('PUT', path, { state: 'paused', revision }, discoveryKey()), 403, 'forbidden');
  expect(await entryRows()).toEqual(before);
  expect(fixture.personas.alice).toEqual(original);
  expect(
    status(await fixture.request('alice', 'PUT', path, { state: 'paused', revision }, discoveryKey()), 200)
      .libraryEntry,
  ).toMatchObject({ state: 'paused', revision: revision + 1 });
  problem(await fixture.request('bob', 'GET', path), 404, 'not_found');
  const readonlyBob = await fixture.scoped('bob', ['library_entry:read']);
  expect(readonlyBob.accountId).toBe(fixture.personas.bob.accountId);
  problem(await readonlyBob.request('GET', path), 404, 'not_found');
  await expect(fixture.scoped('alice', ['fixture:unknown'])).rejects.toThrow();
  await expect(fixture.scoped('outsider' as 'alice', ['library_entry:read'])).rejects.toThrow();
  problem(await fixture.request('suspended', 'GET', '/v1/definitions/active'), 401, 'invalid_credentials');
  expect((await fixture.request('suspended', 'GET', '/v1/definitions/active')).headers.get('www-authenticate')).toBe(
    'Bearer error="invalid_token"',
  );
}, 120_000);

test('explicit named Space setup preserves native persona identity and independent unprivileged controls', async () => {
  const body = { title: 'Discovery capability Space', summary: 'Native Global creation grant control' };
  for (const persona of ['alice', 'bob'] as const)
    problem(await fixture.request(persona, 'POST', '/v1/spaces', body, discoveryKey()), 403, 'forbidden');
  const original = { ...fixture.personas.alice };
  const before = await fixture.inspect<{ action: string; resource_id: string; route: number }>(
    'SELECT * FROM access.resource_grant WHERE subject_id = $1 ORDER BY action',
    [original.accountId],
  );
  await expect(fixture.setup.spaceCreation('invented' as 'alice')).rejects.toThrow();
  await fixture.setup.spaceCreation('alice');
  expect(fixture.personas.alice).toEqual(original);
  const after = await fixture.inspect<{ action: string; resource_id: string; route: number }>(
    'SELECT * FROM access.resource_grant WHERE subject_id = $1 ORDER BY action',
    [original.accountId],
  );
  expect(after.rows.filter((row) => row.action !== 'space:create')).toEqual(before.rows);
  expect(after.rows.filter((row) => row.action === 'space:create')).toMatchObject([
    { route: 0, resource_id: '00000000-0000-8000-8000-000000000000', action: 'space:create' },
  ]);
  const created = status(await fixture.request('alice', 'POST', '/v1/spaces', body, discoveryKey()), 201);
  expect(created.space).toMatchObject({ ...body, creator: original.accountId, state: 'active' });
  problem(await fixture.request('bob', 'POST', '/v1/spaces', body, discoveryKey()), 403, 'forbidden');
  expect(await openings()).toEqual(['collections', 'personal_library', 'reading_progress']);
}, 120_000);

test('owned database inspection is native read-only and expires with fixture cleanup', async () => {
  const before = await entryRows();
  await expect(
    fixture.inspect('UPDATE library.entry SET revision = revision + 1 WHERE account_id = $1 AND subject_id = $2', [
      fixture.personas.alice.accountId,
      book,
    ]),
  ).rejects.toMatchObject({ code: '25006' });
  expect(await entryRows()).toEqual(before);
  expect(
    (await fixture.inspect<{ read_only: string }>("SELECT current_setting('transaction_read_only') AS read_only")).rows,
  ).toEqual([{ read_only: 'on' }]);
  await fixture.close();
  await expect(fixture.inspect('SELECT 1')).rejects.toThrow('closed');
}, 120_000);

test('native scope variants reject known scope escalation and preserve the original person binding', async () => {
  const driver = await createSemanticDriver();
  try {
    const original = await driver.fixtures.person('variant-subset', { scopes: ['subject:read', 'definitions:read'] });
    const variant = await driver.fixtures.scopeVariant(original, ['subject:read']);
    expect(variant.accountId).toBe(original.accountId);
    expect(variant.bearer).not.toBe(original.bearer);
    await expect(driver.fixtures.scopeVariant(variant, ['definitions:read'])).rejects.toThrow('subset');
    await expect(driver.fixtures.scopeVariant(original, ['subject:create'])).rejects.toThrow('subset');
    await expect(driver.fixtures.scopeVariant({ ...original }, ['subject:read'])).rejects.toThrow('existing native');
    await expect(driver.fixtures.person('variant-subset', { scopes: ['subject:read'] })).rejects.toThrow(
      'different scope set',
    );
    status(await driver.fixtures.send(original, 'GET', '/v1/definitions/active'), 200);
  } finally {
    await driver.close();
  }
}, 180_000);
