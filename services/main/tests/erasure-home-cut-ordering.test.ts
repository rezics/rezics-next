import { afterAll, beforeAll, expect, test } from 'bun:test';
import { foregroundCounted } from '../../../tests/qa/integration/support/operation-cost.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult, type SparqlResult }
  from '../src/infrastructure/fuseki.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { readErasure, sha256, journalErasure, extendErasureTargets, ErasureStale } from '../src/modules/erasure/journal.ts';
import { graphErasureReceipt } from '../src/modules/erasure/graph.ts';
import { ErasureService, requestContentErasure } from '../src/modules/erasure/request.ts';
import { lockPreservationTarget } from '../src/modules/public-report/preservation.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const resource = () => `https://rezics.com/id/${randomUUID()}`;
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const boolean = (value: boolean) => ({ ...literal(String(value)),
  datatype: 'http://www.w3.org/2001/XMLSchema#boolean' });
let cluster: PostgresCluster | undefined;
let admin: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = new Pool(cluster.connection);
  await admin.query('CREATE DATABASE erasure_home_template');
  const pool = boundedPool({ ...cluster.connection, database: 'erasure_home_template', max: 4 });
  try {
    await migrateContent(pool);
    for (const file of schemaFiles(root, 'relay')) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/relay', file), 'utf8'));
    }
    await pool.query(`CREATE SCHEMA access;
      CREATE TABLE access.governance_preservation_hold (
        id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
      CREATE TABLE access.governance_erasure_postponement (
        hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL,
        reason text NOT NULL, PRIMARY KEY (hold_id, operation_id, material_ref))`);
    for (const file of ['1765_receipt_custody.sql', '1766_receipt_custody_delivery.sql', '1786_command_custody_erasure.sql']) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
  } finally { await pool.end(); }
}, 120_000);

afterAll(async () => {
  await admin?.end();
  cluster?.remove();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class FenceObservation {
  held = false;
  firstAttempt = deferred();
  identityReads: boolean[] = [];
  graphReads: boolean[] = [];
}

function observedAccess(pool: Pool, observation: FenceObservation): Pool {
  return new Proxy(pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, method) {
        if (method === 'query') return async (sql: string, values?: unknown[]) => {
          const locking = sql.includes('pg_advisory_xact_lock(hashtextextended($1, 931))');
          if (locking) observation.firstAttempt.resolve();
          const result = await connection.query(sql, values);
          if (locking) observation.held = true;
          if (sql === 'COMMIT' || sql === 'ROLLBACK') observation.held = false;
          return result;
        };
        const value = Reflect.get(connection, method, connection);
        return typeof value === 'function' ? value.bind(connection) : value;
      } }) as PoolClient;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
}

function observedContent(pool: Pool, observation: FenceObservation): Pool {
  return new Proxy(pool, { get(target, property) {
    if (property === 'query') return async (sql: string, values?: unknown[]) => {
      if (foregroundCounted() && sql.includes('AS pending_pin')) observation.identityReads.push(observation.held);
      return target.query(sql, values);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
}

class SelectingHomeGraph extends FusekiClient {
  readonly lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
  homes: string[] = [];
  owner: string;
  owned = true;
  failCommands = false;
  inventories: string[][] = [];
  commands: { held: boolean; targets: string[]; retained: string[] }[] = [];
  suppressed = new Set<string>();
  receipts = new Map<string, string>();
  constructor(readonly pool: Pool, readonly document: string, readonly observation: FenceObservation) {
    super('http://erasure-home-owner.invalid');
    this.owner = document;
  }
  override async commandHealth() {
    return { moduleVersion: 'fixture', instanceId: 'fixture', publicSearchWriteEpoch: '0',
      publicSearchWriteActive: false, profiles: { 'erasure-graph-v1': profileRegistry['erasure-graph-v1'].sha256 } };
  }
  override async query(query: string): Promise<SparqlResult> {
    this.observation.graphReads.push(this.observation.held);
    if (query.includes('SELECT DISTINCT ?revision ?owner ?erased ?owned')) {
      const limit = Number(/LIMIT (\d+)/.exec(query)?.[1] ?? this.homes.length);
      this.inventories.push([...this.homes]);
      return { results: { bindings: this.homes.slice(0, limit).map(home => ({ revision: uri(home),
        owner: uri(this.owner), erased: boolean(this.suppressed.has(home)), owned: boolean(this.owned) })) } };
    }
    if (query.includes('SELECT ?target ?erasedEpoch')) {
      const selected = /VALUES \?target \{([^}]+)\}/.exec(query)?.[1] ?? '';
      return { results: { bindings: [...selected.matchAll(/<([^>]+)>/g)].map(match => ({
        target: uri(match[1]!), ...(this.suppressed.has(match[1]!) ? { erasedEpoch: literal('1') } : {}),
      })) } };
    }
    if (query.includes('SELECT DISTINCT ?graph ?unit ?target')) return { results: { bindings: [] } };
    if (query.includes('SELECT DISTINCT ?target')) {
      const selected = /VALUES \?target \{([^}]+)\}/.exec(query)?.[1] ?? '';
      const targets = [...selected.matchAll(/<([^>]+)>/g)].map(match => match[1]!);
      const receipt = [...this.receipts].find(([receipt, digest]) => query.includes(`<${receipt}>`) && query.includes(`"${digest}"`))?.[0];
      return { results: { bindings: receipt ? targets.filter(target => this.suppressed.has(target)).map(target => ({
        target: uri(target), sequence: literal('7'), currentSequence: literal('7'),
        receiptEpoch: literal(this.lineage.dataEpoch), receipt: uri(receipt),
      })) : [] } };
    }
    throw new Error(`unexpected home-owner query: ${query.slice(0, 100)}`);
  }
  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    const row = (await this.pool.query<{ id: string; suppression_receipt: string | null }>(
      'SELECT id, suppression_receipt FROM relay.erasure WHERE operation_id = $1',
      [`erasure:${this.admissionId}`])).rows[0];
    if (!row || envelope.receipt !== (row.suppression_receipt ?? graphErasureReceipt(row.id))) {
      throw new Error('suppression has no matching durable erasure intent');
    }
    const report = await readErasure(this.pool, row.id);
    const targets = [...new Set(envelope.validations.flatMap(validation => validation.focus))].sort();
    const retained = report.targets.map(target => target.kind === 'content_revision'
      ? `urn:rezics:content:revision:${target.ref}` : `https://rezics.com/id/${target.ref}`).sort();
    this.commands.push({ held: this.observation.held, targets, retained });
    expect(this.observation.held).toBe(true);
    expect([...new Set([...targets, ...retained.filter(target => this.suppressed.has(target))])].sort()).toEqual(retained);
    expect(this.homes.every(home => targets.includes(home) || this.suppressed.has(home))).toBe(true);
    if (targets.some(target => this.suppressed.has(target))) {
      return { status: 'invalid', report: { reason: 'erased exact revision cannot be reactivated' } };
    }
    if (this.failCommands) {
      return { status: 'deadline' };
    }
    const retainedDigest = this.receipts.get(envelope.receipt);
    if (retainedDigest && retainedDigest !== envelope.digest) return { status: 'conflict' };
    this.receipts.set(envelope.receipt, envelope.digest);
    for (const target of targets) this.suppressed.add(target);
    return { status: 'committed', position: { datasetId: 'urn:rezics:dataset:product',
      dataEpoch: this.lineage.dataEpoch, sequence: '7' } };
  }
  admissionId = '';
}

async function fixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const database = `erasure_home_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database} TEMPLATE erasure_home_template`);
  const pool = boundedPool({ ...cluster!.connection, database, max: 8 });
  const accessPool = boundedPool({ ...cluster!.connection, database, max: 4 });
  const publicationPool = boundedPool({ ...cluster!.connection, database, max: 2 });
  try { await run(await setup(pool, accessPool, publicationPool)); }
  finally {
    await Promise.all([pool.end(), accessPool.end(), publicationPool.end()]);
    await admin.query(`DROP DATABASE ${database}`);
  }
}

async function setup(pool: Pool, accessPool: Pool, publicationPool: Pool) {
  const document = resource(), observation = new FenceObservation();
  const saved = await new ContentCore(pool).saveDraft({ operationId: randomUUID(),
    variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: document,
      language: { kind: 'zxx' }, direction: 'none' }, expectedHead: null, model: 'fixture',
    sourceRevision: null, provenance: {}, serializedJson: '{"secret":"home document bytes"}' });
  expect(saved.outcome).toBe('succeeded');
  const revision = saved.revisionId!, graph = new SelectingHomeGraph(pool, document, observation);
  let admission: RegisteredAdmission | undefined;
  const access = {
    register: async (input: Omit<RegisteredAdmission, 'id' | 'principalId' | 'authorityEpoch' | 'expiresAt'
      | 'state' | 'dispatchEligible' | 'replayed'>) => {
      if (admission) return { ...admission, replayed: true };
      admission = { ...input, id: randomUUID(), principalId: randomUUID(), authorityEpoch: '1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'registered',
        dispatchEligible: true, replayed: false };
      graph.admissionId = admission.id;
      return admission;
    },
    claim: async () => undefined,
    recordGraphOutcome: async () => { if (admission) admission.state = 'sealed'; },
    activePrincipalId: async () => null,
  };
  const environment: WorkActivationEnvironment = { fuseki: graph, lineage: graph.lineage,
    objectDirectory: join(root, '.temp') };
  const service = new ErasureService(pool, observedContent(pool, observation), observedAccess(accessPool, observation));
  const input = { resourceId: document, actingSubject: resource(), revisionIds: [revision], idempotencyKey: randomUUID() };
  const call = () => requestContentErasure(service, environment,
    { verify: async () => ({ issuer: 'fixture', subject: 'fixture' }) } as never,
    access as never, new Request('http://localhost/v1/erasures'), input);
  const publish = async (home: string) => {
    const client = await publicationPool.connect();
    try {
      await client.query('BEGIN');
      await lockPreservationTarget(client, document);
      graph.homes.push(home);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  return { pool, publicationPool, document, revision, graph, observation, call, publish };
}

test('home publication fences identity, complete inventory, durable journal, suppression and proof together', async () => {
  await fixture(async f => {
    f.graph.homes.push(resource());
    const publisher = await f.publicationPool.connect();
    await publisher.query('BEGIN');
    await lockPreservationTarget(publisher, f.document);
    const initial = f.call().then(result => ({ result }), error => ({ error }));
    try {
      await Promise.race([f.observation.firstAttempt.promise, initial.then(() => {
        throw new Error('erasure completed before waiting for publication');
      })]);
      expect(f.observation.identityReads).toEqual([]);
      expect(f.graph.inventories).toEqual([]);
      expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
      f.graph.homes.push(resource());
      await publisher.query('COMMIT');
      const outcome = await initial;
      expect('error' in outcome ? outcome.error : undefined).toBeUndefined();
      if (!('result' in outcome)) throw outcome.error;
      expect(outcome.result.report.targets.map(target => target.ref).sort()).toEqual([
        f.revision, ...f.graph.homes.map(home => home.slice(-36)),
      ].sort());
      expect(outcome.result.report.targets.every(target => target.completionState === 'completed')).toBe(true);
      expect(f.observation.identityReads.length).toBeGreaterThan(0);
      expect(f.observation.identityReads.every(Boolean)).toBe(true);
      expect(f.observation.graphReads.every(Boolean)).toBe(true);
      expect(f.graph.commands.every(command => command.held)).toBe(true);
      expect(f.observation.held).toBe(false);
    } finally { await publisher.query('ROLLBACK'); publisher.release(); await initial; }
  });
});

test('concurrent same-key callers refresh retained intent after waiting for the home fence', async () => {
  await fixture(async f => {
    f.graph.homes.push(resource());
    const publisher = await f.publicationPool.connect();
    await publisher.query('BEGIN');
    await lockPreservationTarget(publisher, f.document);
    const first = f.call(), second = f.call();
    try {
      await f.observation.firstAttempt.promise;
      await publisher.query('COMMIT');
      const results = await Promise.all([first, second]);
      expect(new Set(results.map(result => result.report.erasureId)).size).toBe(1);
      expect(new Set(results.map(result => result.report.erasureEpoch)).size).toBe(1);
      expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
      expect(results.every(result => result.report.targets.every(target => target.completionState === 'completed'))).toBe(true);
      expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toHaveLength(1);
      expect(f.graph.commands).toHaveLength(1);
    } finally { await publisher.query('ROLLBACK'); publisher.release(); await Promise.allSettled([first, second]); }
  });
});

test('same-key retry reacquires the home fence and durably covers a newly selecting cut before suppression', async () => {
  await fixture(async f => {
    f.graph.homes.push(resource());
    f.graph.failCommands = true;
    await expect(f.call()).rejects.toThrow();
    const row = (await f.pool.query<{ id: string }>('SELECT id FROM relay.erasure')).rows[0]!;
    const before = await readErasure(f.pool, row.id);
    expect(before.targets).toHaveLength(2);
    expect(f.graph.suppressed.size).toBe(0);
    await f.publish(resource());
    f.graph.failCommands = false;
    const retried = await f.call();
    expect(retried.replayed).toBe(true);
    expect(retried.report.erasureId).toBe(before.erasureId);
    expect(retried.report.erasureEpoch).toBe(before.erasureEpoch);
    expect(retried.report.targets.map(target => target.ref).sort()).toEqual([
      f.revision, ...f.graph.homes.map(home => home.slice(-36)),
    ].sort());
    expect(retried.report.targets.every(target => target.completionState === 'completed')).toBe(true);
    expect(f.graph.inventories).toContainEqual([...f.graph.homes]);
    expect(f.observation.graphReads.every(Boolean)).toBe(true);
    expect(f.graph.commands.at(-1)!.targets).toEqual(f.graph.commands.at(-1)!.retained);
  });
});

// Extension state x suppression state: unchanged closures reuse their record;
// new closures get a new receipt before suppressing, in every crash window.
test('home extension reconciles before suppression, after native commit and after header advancement', async () => {
  for (const state of ['before', 'native', 'header'] as const) for (const addition of [false, true]) await fixture(async f => {
    f.graph.homes.push(resource());
    if (state === 'before') {
      f.graph.failCommands = true;
      await expect(f.call()).rejects.toThrow();
      f.graph.failCommands = false;
    } else if (state === 'native') {
      await f.pool.query(`CREATE FUNCTION content.refuse_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'interrupted after native suppression'; END $$;
        CREATE TRIGGER refuse_erasure BEFORE INSERT ON content.revision_erasure
          FOR EACH ROW EXECUTE FUNCTION content.refuse_erasure()`);
      await expect(f.call()).rejects.toThrow('interrupted after native suppression');
      await f.pool.query('DROP TRIGGER refuse_erasure ON content.revision_erasure; DROP FUNCTION content.refuse_erasure()');
    } else await f.call();
    const row = (await f.pool.query<{ id: string }>('SELECT id FROM relay.erasure')).rows[0]!;
    const before = await readErasure(f.pool, row.id), receipts = new Map(f.graph.receipts);
    if (addition) await f.publish(resource());
    const after = (await f.call()).report;
    expect(after.erasureId).toBe(before.erasureId);
    expect(after.erasureEpoch).toBe(before.erasureEpoch);
    expect(after.targets).toHaveLength(before.targets.length + Number(addition));
    expect(after.targets.every(target => target.completionState === 'completed')).toBe(true);
    if (before.suppressedAt) expect(after.suppressedAt).toBe(before.suppressedAt);
    for (const [receipt, digest] of receipts) expect(f.graph.receipts.get(receipt)).toBe(digest);
    if (addition && state !== 'before') expect(f.graph.receipts.size).toBe(receipts.size + 1);
  });
});

test('a newly selecting home already owned by another retained journal refuses atomically', async () => {
  await fixture(async f => {
    f.graph.failCommands = true;
    await expect(f.call()).rejects.toThrow();
    const row = (await f.pool.query<{ id: string }>('SELECT id FROM relay.erasure')).rows[0]!;
    const before = await readErasure(f.pool, row.id), home = resource();
    const other = await journalErasure(f.pool, { operationId: `erasure:${randomUUID()}`, requestDigest: sha256(home),
      kind: 'revision', principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '1',
      targets: [{ kind: 'semantic_revision', ref: home.slice(-36) }] });
    await expect(extendErasureTargets(f.pool, row.id, before.erasureEpoch, before.admissionId!,
      [{ kind: 'semantic_revision', ref: home.slice(-36) }])).rejects.toBeInstanceOf(ErasureStale);
    expect((await readErasure(f.pool, row.id)).targets).toEqual(before.targets);
    expect((await f.pool.query('SELECT erasure_id FROM relay.erasure_target WHERE target_ref=$1',
      [home.slice(-36)])).rows).toEqual([{ erasure_id: other.erasureId }]);
  });
});

test('the home closure accepts 64 total Content and cut targets and refuses 65 before intent or mutation', async () => {
  for (const total of [64, 65]) await fixture(async f => {
    f.graph.homes.push(...Array.from({ length: total - 1 }, resource));
    if (total === 64) {
      const result = await f.call();
      expect(result.report.targets).toHaveLength(64);
      expect(result.report.targets.every(target => target.completionState === 'completed')).toBe(true);
    } else {
      await expect(f.call()).rejects.toThrow();
      expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
      expect(f.graph.commands).toEqual([]);
      expect((await f.pool.query('SELECT availability, serialized_bytes IS NOT NULL AS present FROM content.revision WHERE id=$1',
        [f.revision])).rows[0]).toEqual({ availability: 'available', present: true });
    }
  });
});

test('a selecting cut with stale document ownership refuses before journaling or suppression', async () => {
  await fixture(async f => {
    f.graph.homes.push(resource());
    f.graph.owned = false;
    await expect(f.call()).rejects.toThrow();
    expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
    expect(f.graph.commands).toEqual([]);
    expect(f.observation.graphReads.every(Boolean)).toBe(true);
  });
});
