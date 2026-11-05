import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import { createSemanticDriver } from './outcome-driver.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { accessClock } from '../../src/access/access-clock.ts';
import type { Access } from '../../src/request/access.ts';

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

test('discovery clock follows wall time until frozen and rejects invalid or overflowing advances without mutation', () => {
  const before = Date.now();
  const wall = fixture.clock.now();
  expect(wall.getTime()).toBeGreaterThanOrEqual(before);
  expect(wall.getTime()).toBeLessThanOrEqual(Date.now());
  expect(() => fixture.clock.advanceBy(0)).toThrow('frozen');
  const frozen = fixture.clock.freeze();
  const at = frozen.getTime();
  wall.setTime(0);
  frozen.setTime(0);
  expect(fixture.clock.freeze().getTime()).toBe(at);
  const copy = fixture.clock.now();
  copy.setTime(0);
  expect(fixture.clock.now().getTime()).toBe(at);
  for (const invalid of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => fixture.clock.advanceBy(invalid)).toThrow('safe integer');
    expect(fixture.clock.now().getTime()).toBe(at);
  }
  expect(() => fixture.clock.advanceBy(Number.MAX_SAFE_INTEGER)).toThrow('overflow');
  expect(fixture.clock.now().getTime()).toBe(at);
  const advanced = fixture.clock.advanceBy(1);
  expect(advanced.getTime()).toBe(at + 1);
  advanced.setTime(0);
  expect(fixture.clock.advanceBy(0).getTime()).toBe(at + 1);
  expect(fixture.clock.freeze().getTime()).toBe(at + 1);
});

test('The one released fixture captures a real imported selected HAREM candidate and exact native tuple and exposes actual statement-disclosure controls in the same world without a fake FOREIGN proof', async () => {
  const privacy = fixture.privacy;
  const alice = { ...fixture.personas.alice };
  const [imported, repeated] = await Promise.all([fixture.importedHarem(), fixture.importedHarem()]);
  expect(repeated).toBe(imported);
  expect(imported.subject).not.toBe(book);
  expect(imported.source.source).not.toBe('rezics_reviewed_vocabulary');
  const proposals = imported.bulk.flatMap(({ request, result }) =>
    request.commands.flatMap((command) =>
      command.op === 'propose' &&
      command.subject === imported.subject &&
      command.statement.property.id === 'schema:keywords' &&
      command.statement.value.type === 'value' &&
      command.statement.value.content === imported.sourceConcept
        ? [{ command, result: result.results.find((entry) => entry.key === command.key) }]
        : [],
    ),
  );
  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.command.source).toEqual(imported.source);
  expect(proposals[0]!.result).toMatchObject({ value: { candidate: imported.candidate } });
  const creations = imported.bulk.flatMap(({ request, result }) =>
    request.commands.flatMap((command) =>
      command.op === 'create' &&
      command.subject.type === 'schema:Book' &&
      result.results.some(
        (entry) =>
          entry.key === command.key && 'value' in entry && 'id' in entry.value && entry.value.id === imported.subject,
      )
        ? [command]
        : [],
    ),
  );
  expect(creations).toHaveLength(1);
  expect(creations[0]!.source).toEqual(imported.source);
  expect(imported.current.adoption).toMatchObject({ mode: 'replace' });
  expect(imported.current.candidates.find((row) => row.id === imported.candidate)).toMatchObject({
    source: imported.source,
    decision: 'accepted',
    rank: 'preferred',
    retracted: null,
    retraction: null,
    statement: { property: { id: 'schema:keywords' }, value: { content: imported.sourceConcept } },
  });
  const tuple = imported.dependency.tuple;
  expect(imported.dependency.kind).toBe('sourceTuple');
  expect(tuple).toMatchObject({
    source: imported.source.source,
    external_id: imported.source.external_id,
    field_group: imported.source.field_group,
  });
  const selected = status(await fixture.request('anonymous', 'GET', `/v1/subjects/${imported.subject}`), 200);
  expect((selected.subject as { statements: Record<string, unknown[]> }).statements['schema:keywords']).toContainEqual(
    expect.objectContaining({ id: imported.candidate }),
  );

  const consent = await fixture.statementConsent();
  expect(await fixture.statementConsent()).toBe(consent);
  expect(consent.subject).not.toBe(imported.subject);
  expect(consent.dependency).toMatchObject({ kind: 'consent', subject: consent.subject, candidate: consent.candidate });
  expect(
    (
      await fixture.inspect(
        `SELECT route, account_id::text AS account, subject_id::text AS subject,
            candidate_id::text AS candidate, target_id::text AS target, disclosed
     FROM semantic.statement_disclosure WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
        [consent.dependency.route, consent.subject, consent.candidate],
      )
    ).rows,
  ).toEqual([
    {
      route: consent.dependency.route,
      account: consent.dependency.account,
      subject: consent.subject,
      candidate: consent.candidate,
      target: consent.target,
      disclosed: false,
    },
  ]);
  const body = { source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group, reason: 'denied' };
  problem(await fixture.request('bob', 'POST', '/v1/sourceFences:takedown', body, discoveryKey()), 403, 'forbidden');
  const takenDown = await imported.takedown('Imported keyword provenance control');
  const revision = status(takenDown, 200).securityRevision;
  expect(takenDown.headers.get('rezics-session-token')).toBeTruthy();
  const fence = async () =>
    (
      await fixture.inspect(
        `SELECT taken_down, security_revision::text, taken_down_at::text, takedown_id::text
     FROM content.source_fences WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4`,
        [tuple.route, tuple.source, tuple.external_id, tuple.field_group],
      )
    ).rows;
  const firstFence = await fence();
  expect(firstFence).toEqual([
    {
      taken_down: true,
      security_revision: revision,
      taken_down_at: expect.any(String),
      takedown_id: expect.any(String),
    },
  ]);
  const again = status(await imported.takedown(), 200);
  expect(BigInt(again.securityRevision as string)).toBeGreaterThan(BigInt(revision as string));
  expect(await fence()).toEqual([{ ...firstFence[0], security_revision: again.securityRevision }]);
  const hidden = status(await fixture.request('anonymous', 'GET', `/v1/subjects/${imported.subject}`), 200);
  expect(
    (hidden.subject as { statements: Record<string, unknown[]> }).statements['schema:keywords'] ?? [],
  ).not.toContainEqual(expect.objectContaining({ id: imported.candidate }));
  expect(fixture.personas.alice).toEqual(alice);
  expect(fixture.privacy).toBe(privacy);
  expect(fixture.privacy.state).toBe('prerequisite');
  // These point controls do not settle the original Query/FOREIGN/cross-surface positive cells.
}, 180_000);

test('native statement consent uses its stored owner and route, rejects a different authorized author and retracts terminally', async () => {
  const consent = await fixture.statementConsent();
  const dependency = { ...consent.dependency };
  const path = `/v1/subjects/${consent.subject}`;
  const publicCandidates = async () => {
    const read = status(await fixture.request('anonymous', 'GET', path), 200);
    return (read.subject as { statements: Record<string, { id: string }[]> }).statements['rezics:penNameOf'] ?? [];
  };
  expect(await publicCandidates()).not.toContainEqual(expect.objectContaining({ id: consent.candidate }));
  // Alice has a genuine statement:propose grant from the same reviewed operator setup.
  await fixture.reviewedCatalogueOperator('alice');
  for (const action of ['disclose', 'retract'])
    problem(
      await fixture.request('alice', 'POST', `/v1/statements/${consent.candidate}/${action}`, {}, discoveryKey()),
      403,
      'forbidden',
    );
  const disclosed = await consent.disclose();
  expect(status(disclosed, 200)).toEqual({ candidate: consent.candidate, disclosed: true });
  expect(disclosed.headers.get('rezics-session-token')).toBeTruthy();
  expect(status(await consent.disclose(), 200)).toEqual({ candidate: consent.candidate, disclosed: true });
  expect(await publicCandidates()).toContainEqual(expect.objectContaining({ id: consent.candidate }));
  const retracted = await consent.retract();
  expect(status(retracted, 200)).toEqual({ candidate: consent.candidate, retracted: true });
  expect(retracted.headers.get('rezics-session-token')).toBeTruthy();
  expect(await publicCandidates()).not.toContainEqual(expect.objectContaining({ id: consent.candidate }));
  problem(await consent.disclose(), 409, 'conflict');
  expect(status(await consent.retract(), 200)).toEqual({ candidate: consent.candidate, retracted: true });
  expect(
    (
      await fixture.inspect(
        `SELECT disclosed FROM semantic.statement_disclosure WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
        [dependency.route, dependency.subject, dependency.candidate],
      )
    ).rows,
  ).toEqual([{ disclosed: true }]);
  expect(
    (
      await fixture.inspect(
        `SELECT candidate_id::text FROM semantic.retraction WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
        [dependency.route, dependency.subject, dependency.candidate],
      )
    ).rows,
  ).toEqual([{ candidate_id: consent.candidate }]);
  expect(consent.dependency).toEqual(dependency);
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

test('driver forwards the same trusted clock to installed Access and raw sign-in validates retained account identity and lifetime', async () => {
  const clock = () => new Date();
  let installed: Access | undefined;
  const driver = await createSemanticDriver(
    (config) => {
      expect(config.clock).toBe(clock);
      return createKernel({
        ...config,
        onAccessReady(access, viewerActions) {
          config.onAccessReady?.(access, viewerActions);
          installed = access;
        },
      });
    },
    { clock },
  );
  const original = await driver.fixtures.person('raw-signin');
  try {
    expect(installed).toBeDefined();
    expect(accessClock(installed!)).toBe(clock);
    const retained = { ...original };
    await expect(driver.fixtures.signIn({ ...original })).rejects.toThrow('existing native');
    const signed = await driver.fixtures.signIn(original);
    status(signed, 200);
    expect(signed.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(signed.body).not.toHaveProperty('access_token');
    expect(original).toEqual(retained);
    expect(await driver.fixtures.person('raw-signin')).toBe(original);
    status(await driver.fixtures.send(original, 'GET', '/v1/definitions/active'), 200);
  } finally {
    await driver.close();
  }
  await expect(driver.fixtures.signIn(original)).rejects.toThrow('closed');
}, 180_000);

test('The existing single native discovery world forwards its actual installed Access and one shared Kernel clock and exposes raw native sign-in for the retained original fixture account', async () => {
  const native = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  try {
    // The native runtime requires installed Access and retains the actual missing Source prerequisite.
    expect(await native.search!.preparePublication(1, { deadline: Date.now() + 10_000 })).toMatchObject({
      status: 'unready',
      reason: 'source_pending',
    });
    const original = { ...native.personas.alice };
    const signed = await native.signIn('alice');
    status(signed, 200);
    expect(signed.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(signed.body).not.toHaveProperty('access_token');
    expect(native.personas.alice).toEqual(original);
    const suspended = await native.signIn('suspended');
    status(suspended, 403);
    expect(suspended.body).toEqual({ error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' });
    expect(suspended.headers.getSetCookie()).toEqual([]);
    problem(await native.request('suspended', 'GET', '/v1/definitions/active'), 401, 'invalid_credentials');
    const frozen = native.clock.freeze().getTime();
    expect(native.clock.advanceBy(1).getTime()).toBe(frozen + 1);
    await expect(native.signIn('invented' as 'alice')).rejects.toThrow('named discovery');
  } finally {
    await native.close();
  }
  expect(() => native.clock.advanceBy(0)).toThrow('closed');
  expect(() => native.clock.freeze()).toThrow('closed');
  expect(Number.isFinite(native.clock.now().getTime())).toBe(true);
  await expect(native.signIn('alice')).rejects.toThrow('closed');
}, 180_000);

test('The existing discovery clock forwards each explicit instant to the actual native child and drains that queue before dependent Kernel requests without changing the default clock or fixture world', async () => {
  const native = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  try {
    const search = native.search!;
    expect(search.workerKind).toBe('owned-child');
    const clock = native.clock;
    const prefix = search.indexPrefix;
    const alice = { ...native.personas.alice };
    const before = Date.now();
    const initial = await search.workerStats();
    expect(initial.clockInstant).toBeGreaterThanOrEqual(before);
    expect(initial.clockInstant).toBeLessThanOrEqual(Date.now());
    expect(() => clock.advanceBy(0)).toThrow('frozen');

    const subject = await native.createSubject('schema:Book', 'Shared child clock transport control');
    const scoped = await native.scoped('alice', ['subject:read', 'definitions:read']);
    const importer = await native.reviewedCatalogueOperator('alice');
    const frozen = clock.freeze();
    const at = frozen.getTime();
    const first = search.workerStats();
    frozen.setTime(0);
    const advanced = clock.advanceBy(1);
    const second = search.workerStats();
    advanced.setTime(0);
    expect(clock.freeze().getTime()).toBe(at + 1);
    const repeated = search.workerStats();
    expect(clock.advanceBy(0).getTime()).toBe(at + 1);
    const unchanged = search.workerStats();
    status(await native.request('anonymous', 'GET', '/v1/definitions/active'), 200);
    expect((await first).clockInstant).toBe(at);
    expect((await second).clockInstant).toBe(at + 1);
    expect((await repeated).clockInstant).toBe(at + 1);
    expect((await unchanged).clockInstant).toBe(at + 1);

    clock.advanceBy(1);
    status(await native.request('alice', 'GET', '/v1/definitions/active'), 200);
    expect((await search.workerStats()).clockInstant).toBe(at + 2);
    clock.advanceBy(1);
    status(await scoped.request('GET', '/v1/definitions/active'), 200);
    expect((await search.workerStats()).clockInstant).toBe(at + 3);
    clock.advanceBy(1);
    expect((await importer.readReviewedSubject(subject.id)).subject.id).toBe(subject.id);
    expect((await search.workerStats()).clockInstant).toBe(at + 4);

    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => clock.advanceBy(invalid)).toThrow('safe integer');
    expect(() => clock.advanceBy(Number.MAX_SAFE_INTEGER)).toThrow('overflow');
    expect(clock.now().getTime()).toBe(at + 4);
    expect((await search.workerStats()).clockInstant).toBe(at + 4);
    expect(native.clock).toBe(clock);
    expect(search.indexPrefix).toBe(prefix);
    expect(native.personas.alice).toEqual(alice);
  } finally {
    await native.close();
  }
}, 180_000);
