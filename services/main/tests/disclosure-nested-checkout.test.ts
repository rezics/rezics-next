import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { ensureFixtureScopeGate, provisionFixturePerson, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import { PersonPreferencesStore } from '../src/modules/preferences/store.ts';
import { accessClient, controlRead, controlTransaction, withAccessClient } from '../src/modules/access/topology-control.ts';
import { configureDisclosure, configureDisclosureAncestrySource, DISCLOSURE_COST, discloseInventory, discloseInventoryWithAnonymousNames, resolveDisclosureSelections,
  DisclosureStore, DisclosureUnavailable, type DisclosureAncestryEvidence, type DisclosureDecision, type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const work = native(), publicAgent = native(), inactiveAgent = native();
const gate = `work:read:${work}`;
const previousMode = nestedPoolCheckoutMode();
const graph = new FusekiClient('http://graph.invalid');
const environment = { fuseki: graph, objectDirectory: '.temp/disclosure-nested-checkout',
  lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
let cluster: PostgresCluster | undefined;
let pool: Pool;
let other: Pool;
let reader: DisclosureStore;
let poolOnly: DisclosureStore;
let issuedBody: DisclosureTarget;
let issuedRestricted: DisclosureTarget;
let issuedPoolNames: DisclosureTarget[];
const body: DisclosureTarget = { owner: 'content', resource: native(), component: 'body' };
const restricted: DisclosureTarget = { ...body, resource: native(), work, workRevision: native() };
const names: DisclosureTarget[] = [publicAgent, inactiveAgent].map(resource => ({
  owner: 'graph', resource, component: 'name', revision: native(), nameOwner: resource,
}));

beforeAll(async () => {
  setNestedPoolCheckoutMode('throw');
  cluster = await startPostgresCluster();
  pool = boundedPool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  other = boundedPool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
  await pool.query("INSERT INTO access.authority_subject(id,kind,active) VALUES ($1,'agent',true),($2,'agent',false)",
    [publicAgent, inactiveAgent]);
  await ensureFixtureScopeGate(pool, gate, { open: false });
  // A trusted fixture owner proves each selected occurrence; context alone is
  // never an ancestry descriptor. Head and name probes stay graph-only.
  graph.query = async sql => ({ results: { bindings: (sql.includes('SELECT ?resource ?head')
    ? [work].filter(resource => sql.includes(`<${resource}>`))
      .map(resource => ({ resource: { type: 'uri', value: resource }, head: { type: 'uri', value: restricted.workRevision! } }))
    : [publicAgent, inactiveAgent].filter(resource => sql.includes(`<${resource}>`))
      .map(resource => ({ work: { type: 'uri', value: resource } }))) } });
  reader = new DisclosureStore(pool);
  configureDisclosure(environment, reader);
  const evidence = (target: DisclosureTarget): DisclosureAncestryEvidence => {
    const relationshipBasis = { owner: target.owner === 'graph' ? 'graph' as const : 'content' as const,
      kind: 'publication' as const, resource: target.resource, revision: target.revision ?? 'urn:rezics:fixture:revision',
      targetResource: target.resource, targetRevision: target.revision ?? null,
      token: createHash('sha256').update(JSON.stringify(target)).digest('hex'), dataEpoch: environment.lineage.dataEpoch };
    return { resource: target.resource, resourceKind: 'other', relationshipBasis, status: 'complete',
      parents: target.resource === restricted.resource ? [{ owner: 'graph', kind: 'work', resource: work,
        head: restricted.workRevision!, protectedRevision: restricted.workRevision!, relationshipBasis }] : [] };
  };
  for (const owner of ['graph', 'content'] as const) configureDisclosureAncestrySource(environment, owner, {
    read: async targets => targets.map(evidence),
    reread: async bases => bases.map(basis => evidence([body, restricted, ...names]
      .find(target => target.resource === basis.targetResource)!)),
  });
  poolOnly = new DisclosureStore(other);
  const issued = (await resolveDisclosureSelections(environment, [body, restricted,
    ...names.map(({ nameOwner: _owner, ...target }) => target)]))
    .map(selection => ({ ...selection.target, ancestry: selection.ancestry }));
  issuedBody = issued[0]!;
  issuedRestricted = issued[1]!;
  issuedPoolNames = issued.slice(2);
}, 120_000);

afterAll(async () => {
  await other?.end();
  await pool?.end();
  cluster?.remove();
  setNestedPoolCheckoutMode(previousMode);
}, 60_000);

test('reader language and public profile reads reuse the held Access client and see its current writes', async () => {
  const preferences = new PersonPreferencesStore(pool);
  const principal = { issuer: 'https://account.test', subject: randomUUID(), emailVerified: true };
  const principalId = randomUUID(), actor = native();
  await controlTransaction(pool, async client => {
    await registerFixtureIdentity(client, { principalId, issuer: principal.issuer, subject: principal.subject, actor });
    await provisionFixturePerson(client, { principalId, actor, dataEpoch: environment.lineage.dataEpoch });
    await client.query(`INSERT INTO access.person_preferences(agent_id,content_languages,version)
      VALUES ($1,$2,1)`, [actor, ['ja', 'en']]);
    expect(await preferences.languagesForReader(principal)).toEqual(['ja', 'en']);
    expect(await preferences.publicDiscoveryProfiles([actor, inactiveAgent])).toEqual(new Set([actor]));
    await expect(pool.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
  });
  expect(await preferences.languagesForReader(principal)).toEqual(['ja', 'en']);
  expect(await preferences.publicDiscoveryProfiles([actor, inactiveAgent])).toEqual(new Set([actor]));
});

test('held topology reads disclose every inventory batch with unchanged visible, tombstone and hidden decisions', async () => {
  const targets = [...Array.from({ length: DISCLOSURE_COST.batch }, () => body), restricted, ...names];
  for (const channel of ['thread', 'search'] as const) {
    const ordinary = await discloseInventory(environment, targets, ANONYMOUS_VIEWER, channel);
    const expected: DisclosureDecision[] = [...Array.from({ length: DISCLOSURE_COST.batch }, () => 'visible' as const),
      channel === 'thread' ? 'tombstone' : 'hidden', 'visible', 'hidden'];
    expect(ordinary).toEqual(expected);
    await controlRead(pool, async client => {
      expect(accessClient(pool)).toBe(client);
      const held = await discloseInventory(environment, targets, ANONYMOUS_VIEWER, channel);
      expect(held).toEqual(ordinary);
      expect(held.cost!.ownerStatements).toBe(2);
      expect(held.cost!.statements).toBe(ordinary.cost!.statements);
      expect((await client.query('SHOW lock_timeout')).rows[0]?.lock_timeout).toBe('2s');
      expect((await client.query('SHOW statement_timeout')).rows[0]?.statement_timeout).toBe('5s');
      // The detector remains armed against a real second checkout.
      await expect(pool.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    });
  }
  const ordinary = await discloseInventoryWithAnonymousNames(environment, names, ANONYMOUS_VIEWER, 'summary');
  expect(ordinary.decisions).toEqual(['visible', 'hidden']);
  expect(ordinary.anonymousNames).toEqual(ordinary.decisions);
  await controlRead(pool, async () => {
    expect(await discloseInventoryWithAnonymousNames(environment, names, ANONYMOUS_VIEWER, 'summary')).toEqual(ordinary);
  });
}, 30_000);

test('pool-only Agent ownership probes and paired names reuse the same held client', async () => {
  const targets = issuedPoolNames;
  expect(poolOnly.environment).toBeUndefined();
  await expect(poolOnly.read(names, ANONYMOUS_VIEWER, 'summary')).rejects.toBeInstanceOf(DisclosureUnavailable);
  const ordinary = await poolOnly.readWithAnonymousNames(targets, ANONYMOUS_VIEWER, 'summary');
  expect(ordinary).toEqual({ decisions: ['visible', 'hidden'], anonymousNames: ['visible', 'hidden'] });
  await controlRead(other, async () => {
    expect(await poolOnly.read(targets, ANONYMOUS_VIEWER, 'summary')).toEqual(ordinary.decisions);
    expect(await poolOnly.readWithAnonymousNames(targets, ANONYMOUS_VIEWER, 'summary')).toEqual(ordinary);
  });
}, 30_000);

test('disclosure keeps caller policy changes and rollback in the held transaction', async () => {
  expect(await reader.read([issuedRestricted], ANONYMOUS_VIEWER, 'thread')).toEqual(['tombstone']);
  await expect(controlTransaction(pool, async client => {
    const id = (await client.query('SELECT txid_current()::text AS id')).rows[0]!.id;
    await ensureFixtureScopeGate(client, gate, { open: true });
    expect(await discloseInventory(environment, [restricted], ANONYMOUS_VIEWER, 'thread')).toEqual(['visible']);
    expect((await client.query('SELECT txid_current()::text AS id')).rows[0]!.id).toBe(id);
    throw new Error('caller rolls back');
  })).rejects.toThrow('caller rolls back');
  expect(await reader.read([issuedRestricted], ANONYMOUS_VIEWER, 'thread')).toEqual(['tombstone']);
}, 30_000);

test('explicit disclosure clients win over the same pool held context', async () => {
  await controlRead(pool, async held => {
    await expect(controlTransaction(other, async explicit => {
      await ensureFixtureScopeGate(explicit, gate, { open: true });
      expect(await reader.read([issuedRestricted], ANONYMOUS_VIEWER, 'thread')).toEqual(['tombstone']);
      expect(await discloseInventory(environment, [restricted], ANONYMOUS_VIEWER, 'thread', explicit)).toEqual(['visible']);
      expect(accessClient(pool)).toBe(held);
      throw new Error('explicit rolls back');
    })).rejects.toThrow('explicit rolls back');
  });
}, 30_000);

test('concurrent siblings and completed scopes cannot reuse released disclosure clients', async () => {
  let retained: AsyncResource | undefined;
  await Promise.all([
    controlRead(pool, async () => {
      expect(await reader.read([issuedBody], ANONYMOUS_VIEWER, 'thread')).toEqual(['visible']);
      retained = new AsyncResource('retained-disclosure');
    }),
    controlRead(pool, async () => {
      expect(await discloseInventory(environment, [restricted], ANONYMOUS_VIEWER, 'thread')).toEqual(['tombstone']);
    }),
  ]);
  try {
    expect(await retained!.runInAsyncScope(() => reader.read([issuedBody], ANONYMOUS_VIEWER, 'thread'))).toEqual(['visible']);
    expect(accessClient(pool)).toBeUndefined();
  } finally { retained?.emitDestroy(); }
}, 30_000);

test('held disclosure preserves recovery fencing and SQL error normalization, then recovers', async () => {
  await withAccessClient(pool, async client => {
    await client.query('BEGIN');
    try {
      await client.query('UPDATE access.recovery_fence SET open=false WHERE id');
      await expect(reader.read([issuedBody], ANONYMOUS_VIEWER, 'thread')).rejects.toThrow('Disclosure result is incomplete');
    } finally { await client.query('ROLLBACK'); }
    await client.query('BEGIN');
    try {
      await client.query('ALTER TABLE access.governance_enforcement RENAME TO unavailable_enforcement');
      const error = await reader.read([issuedBody], ANONYMOUS_VIEWER, 'thread').catch(cause => cause);
      expect(error).toBeInstanceOf(DisclosureUnavailable);
      expect(error.message).toBe('Disclosure owner is unavailable');
      expect(error.cause.code).toBe('42P01');
    } finally { await client.query('ROLLBACK'); }
    expect(await reader.read([issuedBody], ANONYMOUS_VIEWER, 'thread')).toEqual(['visible']);
  });
  expect(await discloseInventory(environment, [body], ANONYMOUS_VIEWER, 'thread')).toEqual(['visible']);
}, 30_000);
