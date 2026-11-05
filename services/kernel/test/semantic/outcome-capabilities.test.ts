import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HttpResponse, Persona } from '../../../../specs/semantic-driver.ts';
import { constructionFixture } from '../../../../packages/definitions/test/support/publication-construction.ts';
import { createAuthenticator } from '../../src/access/authenticate.ts';
import { readExposure } from '../../src/access/gates/catalogue.ts';
import { createSemanticDriver as createOriginalDriver } from './outcome-binding.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';
import { effectsSnapshot } from './support/definition-publication-work.ts';

const key = () => ({ 'Idempotency-Key': JSON.stringify(randomUUID()) });
const groups = ['definition_publication', 'subject_identity'] as const;
type Write = readonly [string, unknown];
function write(driver: SemanticOutcomeDriver, who: Persona, [path, body]: Write) {
  return driver.request(who, 'POST', path, body, key());
}
function problem(response: HttpResponse, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.body).toMatchObject({ status, code, effect_status: 'not_applied' });
  if (code === 'invalid_credentials') expect(response.headers.get('www-authenticate')).toContain('invalid_token');
}
async function gatedWrites(driver: SemanticOutcomeDriver): Promise<Write[]> {
  const active = await driver.request('anonymous', 'GET', '/v1/definitions/active');
  expect(active.status).toBe(200);
  return [
    ['/v1/definitions/releases', { release: constructionFixture() }],
    [`/v1/definitions/releases/${active.body.digest}:activate`, { expected_head: active.body.head }],
    ['/v1/subjects:merge', { subjects: [Bun.randomUUIDv7(), Bun.randomUUIDv7()] }],
  ];
}
async function closedDiscovery(driver: SemanticOutcomeDriver) {
  for (const group of groups) {
    const exposure = await readExposure(driver.fixtures.pool, group, new Date(), Date.now() + 10_000);
    expect(exposure.open).toBe(false);
  }
  const response = await driver.request('anonymous', 'GET', '/v1/openapi.json');
  expect(response.status).toBe(200);
  const paths = response.body.paths as Record<string, Record<string, { operationId: string }>>;
  const operations = Object.values(paths).flatMap((path) => Object.values(path).map((op) => op.operationId));
  for (const operation of ['definitions.publish', 'definitions.activate', 'subject.merge'])
    expect(operations).not.toContain(operation);
  expect(operations).toContain('subject.create');
  expect(operations).toContain('definitions.read_active');
}
async function gates(driver: SemanticOutcomeDriver, name: string) {
  const account = await driver.fixtures.person(name);
  const result = await driver.fixtures.pool.query<{ action: string }>(
    `SELECT action FROM access.resource_grant
      WHERE route=0 AND resource_id=$1 AND subject_kind='identity' AND subject_role='' AND subject_id=$2
        AND action LIKE 'gate:%' AND valid @> now()
      ORDER BY action`,
    [driver.globalContext, account.accountId],
  );
  return result.rows.map(({ action }) => action);
}
async function claims(driver: SemanticOutcomeDriver) {
  const runtime = driver.fixtures.runtime;
  const authenticator = createAuthenticator({
    issuer: runtime.authIssuer,
    audience: runtime.authAudience,
    jwksUrl: runtime.authJwksUrl,
  });
  let ordinaryScopes: readonly string[] | undefined;
  for (const name of ['editor', 'acceptor', 'steward'] as const) {
    const account = await driver.fixtures.person(name);
    const actor = await authenticator.authenticate(account.bearer, {
      pool: driver.fixtures.pool,
      deadline: Date.now() + 10_000,
    });
    expect(actor.kind).toBe('account');
    if (actor.kind !== 'account') throw new Error('Native fixture did not authenticate an account');
    expect(actor.accountId).toBe(account.accountId);
    expect(actor.clientId).toBe('semantic-outcomes');
    expect(actor.scopes.filter((scope) => scope.startsWith('gate:'))).toEqual([]);
    expect(actor.scopes).not.toContain('media:complete');
    for (const action of ['definitions:publish', 'definitions:activate', 'subject:merge'])
      expect(actor.scopes).toContain(action);
    if (ordinaryScopes) expect(actor.scopes).toEqual(ordinaryScopes);
    ordinaryScopes = actor.scopes;
  }
  const governor = await driver.fixtures.person('governor', { scopes: [...ordinaryScopes!, 'gate:any'] });
  const actor = await authenticator.authenticate(governor.bearer, {
    pool: driver.fixtures.pool,
    deadline: Date.now() + 10_000,
  });
  expect(actor.kind).toBe('account');
  if (actor.kind === 'account') expect(actor.scopes.filter((scope) => scope.startsWith('gate:'))).toEqual(['gate:any']);
  await expect(driver.fixtures.person('editor', { scopes: ['subject:read'] })).rejects.toThrow('different scope set');
  await expect(driver.fixtures.person('unknown-scope', { scopes: ['gate:unknown'] })).rejects.toThrow('Unknown');
}

test('default semantic factory retains closed gates, ordinary claims and unchanged public discovery', async () => {
  const driver = await createSemanticDriver();
  try {
    await claims(driver);
    await closedDiscovery(driver);
    for (const name of ['editor', 'acceptor', 'steward']) expect(await gates(driver, name)).toEqual([]);
    const writes = await gatedWrites(driver);
    const before = await effectsSnapshot(driver.fixtures.pool);
    for (const who of ['anonymous', 'editor', 'acceptor', 'steward'] as const)
      for (const operation of writes) problem(await write(driver, who, operation), 403, 'platform_closed');
    for (const operation of writes) problem(await write(driver, 'suspended', operation), 401, 'invalid_credentials');
    expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(before);
  } finally {
    await driver.close();
  }
}, 120_000);

test('original binding grants only named native gates, preserves resource denials and runs real commands', async () => {
  const driver = await createOriginalDriver();
  try {
    await claims(driver);
    expect(await gates(driver, 'steward')).toEqual(['gate:definition_publication']);
    expect(await gates(driver, 'acceptor')).toEqual(['gate:subject_identity']);
    expect(await gates(driver, 'editor')).toEqual(['gate:definition_publication', 'gate:subject_identity']);
    expect(await gates(driver, 'suspended')).toEqual([]);
    const editor = await driver.fixtures.person('editor');
    const domain = await driver.fixtures.pool.query(
      `SELECT action FROM access.resource_grant
        WHERE route=0 AND resource_id=$1 AND subject_kind='identity' AND subject_role='' AND subject_id=$2
          AND action=ANY($3::text[]) AND valid @> now()`,
      [driver.globalContext, editor.accountId, ['definitions:publish', 'definitions:activate', 'subject:merge']],
    );
    expect(domain.rows).toEqual([]);
    await closedDiscovery(driver);
    const operations = await gatedWrites(driver);
    const before = await effectsSnapshot(driver.fixtures.pool);
    for (const operation of operations) {
      problem(await write(driver, 'editor', operation), 403, 'forbidden');
      problem(await write(driver, 'anonymous', operation), 403, 'platform_closed');
      problem(await write(driver, 'suspended', operation), 401, 'invalid_credentials');
    }
    for (const operation of [
      ['/v1/subjects', { type: 'schema:Book', labels: { en: 'Denied' } }],
      ['/v1/contexts', { labels: { en: 'Denied' } }],
      [`/v1/subjects/${Bun.randomUUIDv7()}/candidates`, { statement: {} }],
      [
        `/v1/subjects/${Bun.randomUUIDv7()}/candidates/${Bun.randomUUIDv7()}:accept`,
        { context: driver.globalContext, expected_head: null },
      ],
      [
        `/v1/subjects/${Bun.randomUUIDv7()}:adopt`,
        { context: driver.globalContext, property: 'schema:url', mode: 'replace', selection: [], expected_head: null },
      ],
    ] as const)
      problem(await write(driver, 'anonymous', operation), 401, 'authentication_required');
    expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(before);

    const active = await driver.request('anonymous', 'GET', '/v1/definitions/active');
    const release = constructionFixture();
    const published = await write(driver, 'steward', ['/v1/definitions/releases', { release }]);
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const activated = await write(driver, 'steward', [
      `/v1/definitions/releases/${published.body.digest}:activate`,
      { expected_head: active.body.head },
    ]);
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    const subjects: string[] = [];
    for (const label of ['First native identity', 'Second native identity']) {
      const created = await write(driver, 'editor', ['/v1/subjects', { type: 'schema:Person', labels: { en: label } }]);
      expect(created.status).toBe(201);
      subjects.push((created.body.subject as { id: string }).id);
    }
    const revisions = await Promise.all(subjects.map((id) => driver.inspect.revisions(id)));
    const merge = ['/v1/subjects:merge', { subjects }] as const;
    const denied = await effectsSnapshot(driver.fixtures.pool);
    problem(await write(driver, 'editor', merge), 403, 'forbidden');
    expect(await effectsSnapshot(driver.fixtures.pool)).toEqual(denied);
    expect(await Promise.all(subjects.map((id) => driver.inspect.revisions(id)))).toEqual(revisions);
    const merged = await write(driver, 'acceptor', merge);
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body).toMatchObject({
      survivor: [...subjects].sort()[0],
      redirected: [...subjects].sort()[1],
      revision: 2,
    });
    await closedDiscovery(driver);
    console.log(
      'original native capability receipt',
      JSON.stringify({
        gates: {
          steward: await gates(driver, 'steward'),
          acceptor: await gates(driver, 'acceptor'),
          editor: await gates(driver, 'editor'),
        },
        published: published.status,
        activated: activated.status,
        merged: merged.status,
        editor: 'forbidden/no effects',
        anonymousGate: 'platform_closed',
        anonymousOrdinary: 'authentication_required',
        suspended: 'invalid_credentials/invalid_token',
        publicGroups: 'closed',
      }),
    );
  } finally {
    await driver.close();
  }
}, 120_000);
