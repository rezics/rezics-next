import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import type { FusekiClient, TemplateIndexDelta, TemplateIndexKey } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { accessClient, controlRead, controlTransaction, ControlConflict, ControlUnavailable } from '../src/modules/access/topology-control.ts';
import { AliasRegistry } from '../src/modules/address/registry.ts';
import { TemplateSeekIndex } from '../src/modules/query/seek-index.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const previousMode = nestedPoolCheckoutMode();
const actor = native(), work = native(), semantic = native();
const principal: VerifiedPrincipal = { issuer: 'https://account.nested.test', subject: randomUUID(), emailVerified: true };
const absent = { ...principal, subject: 'absent' };
const ownerRequest = { principal, actingSubject: actor, action: 'work.create', scope: 'work:create:root' };
let cluster: PostgresCluster | undefined;
let pool: Pool;
let other: Pool;
let admission: AccessAdmissionRegistry;

beforeAll(async () => {
  setNestedPoolCheckoutMode('throw');
  cluster = await startPostgresCluster();
  pool = boundedPool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  other = boundedPool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
  const id = randomUUID();
  await pool.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [id, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
  for (const [action, scope] of [['work.create', 'work:create:root'], ['work.read', `work:read:${work}`], ['semantic.read', `semantic:read:${semantic}`]]) {
    await controlTransaction(pool, client => grantFixtureAuthority(client, {
      scope: scope!, requireDispatch: true,
      representations: [{ principalId: id, actor, action: action!, lifetime: 'infinity' }],
      grant: { actor, action: action!, lifetime: 'infinity' },
    }));
  }
  admission = new AccessAdmissionRegistry(pool);
}, 120_000);

afterAll(async () => {
  await other?.end();
  await pool?.end();
  cluster?.remove();
  setNestedPoolCheckoutMode(previousMode);
}, 60_000);

test('a semantic admission graph callback joins topology reads on its one held client', async () => {
  let nested = false;
  let calls = 0;
  admission.configureBaseline({ query: async sql => {
    // This callback runs in scopedResourceDecision, after public disclosure.
    if (nested && sql.includes('SELECT ?admission ?receipt ?digest')) {
      const held = accessClient(pool);
      expect(held).toBeDefined();
      await controlRead(pool, async client => {
        expect(client).toBe(held!);
        expect((await client.query("SHOW lock_timeout")).rows[0]?.lock_timeout).toBe('2s');
        expect((await client.query("SHOW statement_timeout")).rows[0]?.statement_timeout).toBe('5s');
        calls++;
      });
    }
    return { results: { bindings: [] } };
  } });
  for (const identity of [principal, absent]) {
    nested = false;
    const ordinary = await admission.canReadSemanticResource(identity, actor, semantic);
    nested = true;
    expect(await admission.canReadSemanticResource(identity, actor, semantic)).toBe(ordinary);
    expect(ordinary).toBe(identity === principal);
  }
  expect(calls).toBe(1);
}, 30_000);

test('topology reentry and admission reentry keep caller transaction and allow/deny decisions', async () => {
  const ordinary = await Promise.all([principal, absent].map(identity => admission.canReadWork(identity, actor, work)));
  expect(ordinary).toEqual([true, false]);
  const marker = randomUUID();
  await expect(controlTransaction(pool, async client => {
    const id = (await client.query('SELECT txid_current()::text AS id')).rows[0]!.id;
    await controlTransaction(pool, async inner => {
      expect(inner).toBe(client);
      expect((await inner.query('SELECT txid_current()::text AS id')).rows[0]!.id).toBe(id);
      await inner.query('INSERT INTO access.template_seek_pending(epoch,sequence,id,delta) VALUES ($1,1,$2,$3)',
        [marker, 'rollback', { bases: [] }]);
    });
    for (const [index, identity] of [principal, absent].entries()) {
      expect(await admission.canReadWork(identity, actor, work)).toBe(ordinary[index]);
      expect(await admission.canReadSemanticResource(identity, actor, semantic)).toBe(identity === principal);
    }
    throw new Error('caller rolls back');
  })).rejects.toThrow('caller rolls back');
  expect((await pool.query('SELECT id FROM access.template_seek_pending WHERE epoch=$1', [marker])).rowCount).toBe(0);
}, 30_000);

test('ordinary owner callbacks reuse the checkout for aliases, nested owner authority and seek projection', async () => {
  const aliases = new AliasRegistry(pool);
  const epoch = randomUUID();
  const key: TemplateIndexKey = { graph: 'urn:rezics:graph:current', predicate: 'https://rezics.com/vocab/work',
    anchor: work, type: 'https://rezics.com/vocab/AuthorCredit' };
  const delta: TemplateIndexDelta = { position: { dataEpoch: epoch, sequence: '1' },
    bases: [{ ...key, sequence: '1', previous: '0' }],
    entities: [{ graph: key.graph, id: actor, terms: { type: [key.type], work: [work], role: ['author'], ordinal: ['0'], externalKey: ['reader'] } }] };
  const index = new TemplateSeekIndex(pool, {
    attachTemplateIndexWriter: () => {},
    templateIndex: async () => ({ position: delta.position, bases: delta.bases }),
  } as unknown as FusekiClient);
  const ordinaryAliases = await aliases.currents([actor]);
  await expect(admission.withOwnerAuthority(ownerRequest, async client => {
    expect(await aliases.currents([actor])).toEqual(ordinaryAliases);
    await aliases.withRead(async held => expect(held).toBe(client));
    await admission.withOwnerAuthority(ownerRequest, async inner => expect(inner).toBe(client));
    await controlTransaction(pool, async inner => expect(inner).toBe(client));
    await index.apply(delta);
    await client.query('INSERT INTO access.template_seek_checkpoint(epoch,instance,complete) VALUES ($1,$2,true)', [epoch, randomUUID()]);
    expect(await index.keys(epoch, [key])).toEqual(delta.bases);
    const page = await index.candidates(epoch, [key], null, 10);
    expect(page.rows.map(row => row.id)).toEqual([actor]);
    expect(await index.confirmed(epoch, [work], ['reader'])).toEqual(new Set([`${work}\0reader`]));
    throw new Error('owner rolls back');
  })).rejects.toThrow('owner rolls back');
  expect((await index.candidates(epoch, [key], null, 10)).rows).toEqual([]);
}, 30_000);

test('concurrent admission and topology siblings have separate one-client checkouts', async () => {
  // Regression from the diagnostic: connect instrumentation uses enterWith,
  // so a checkout must be scoped before its first asynchronous suspension.
  const read = admission.canReadAsBaselineMember(absent, actor);
  const sibling = controlRead(pool, async () => 'sibling');
  expect(await read).toBe(false);
  expect(await sibling).toBe('sibling');
  const addresses = new AliasRegistry(pool);
  await addresses.withRead(async client => {
    expect(await addresses.currents([actor])).toEqual(await addresses.currents([actor], client));
    expect(await admission.canReadAsBaselineMember(absent, actor)).toBe(false);
    expect(await controlRead(pool, async inner => inner === client)).toBe(true);
  });
}, 30_000);

test('explicit clients win and separate pools and completed scopes cannot inherit a checkout', async () => {
  const independent = new AsyncResource('independent-access');
  let after: (() => PoolClient | undefined) | undefined;
  await controlRead(pool, async client => {
    await controlRead(other, async second => {
      expect(second).not.toBe(client);
      expect(accessClient(pool)).toBe(client);
      expect(accessClient(other)).toBe(second);
      await controlRead(pool, async explicit => expect(explicit).toBe(second), second);
      expect(accessClient(pool)).toBe(client);
    });
    expect(independent.runInAsyncScope(() => accessClient(pool))).toBeUndefined();
    const retained = new AsyncResource('retained-access');
    after = () => retained.runInAsyncScope(() => accessClient(pool));
    // The existing detector still rejects an actual unmanaged nested checkout.
    await expect(pool.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
  });
  expect(after!()).toBeUndefined();
  expect(accessClient(pool)).toBeUndefined();
  expect(await controlRead(pool, async () => 'recovered')).toBe('recovered');
}, 30_000);

test('closed recovery and failed owner SQL keep their existing error normalization', async () => {
  await pool.query('UPDATE access.recovery_fence SET open=false WHERE id');
  try {
    await expect(controlRead(pool, async () => true)).rejects.toBeInstanceOf(ControlUnavailable);
    await expect(admission.canReadAsBaselineMember(absent, actor)).rejects.toBeInstanceOf(AdmissionUnavailable);
  } finally { await pool.query('UPDATE access.recovery_fence SET open=true WHERE id'); }
  await expect(controlTransaction(pool, async client => {
    await client.query('INSERT INTO access.principal(id,account_issuer,account_subject) SELECT id,account_issuer,account_subject FROM access.principal LIMIT 1');
  })).rejects.toBeInstanceOf(ControlConflict);
  expect(await controlRead(pool, async () => 'recovered')).toBe('recovered');
}, 30_000);
