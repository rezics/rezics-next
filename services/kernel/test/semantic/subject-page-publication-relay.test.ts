import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { runCommand, type CommandEvent, type CommandTransaction } from '../../src/command/command.ts';
import { projectBatch, type CloudEvent } from '../../src/events/log.ts';
import type { Relay } from '../../src/events/relays.ts';
import type { Access } from '../../src/request/access.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { readFences } from '../../src/content/source-fences.ts';
import { fenceKey, sourceTuple } from '../../src/semantic/fences.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';
import type { PublicationRunner, PublicationStore, SubjectKey } from './subject-page-local-publication.test.ts';

// Only type imports from admitted native acceptance. Its tests are never registered here.
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let access: Access;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const editor = '019a1b2c-3d4e-7f00-8a00-ed170e000193';
const routeKey = new Uint8Array(32).fill(93);
const origin = Date.now();
let now = new Date(origin);
const clock = () => now;
const at = (seconds: number) => (now = new Date(origin + seconds * 1000)).toISOString();
const actions = [
  'subject:create',
  'subject:read',
  'subject:batch_write',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'source_fence:takedown',
];
type Owner = { kind: 'subject' | 'source-fence'; route: number; key: string };
type Time = { effectiveAt: string | null; evidence: 'known' | 'missing' };
type Delta = {
  owner: Owner;
  subject: SubjectKey;
  component: { kind: 'relation'; key: string };
  sourceVersion: string;
  eventId: string;
  present: boolean;
  time: Time;
  outbox: CommandEvent[];
};
type StoreModule = {
  createSubjectPagePublicationStore(input: {
    pool: Pool;
    access: Access;
    clock: () => Date;
    routeKey: Uint8Array;
  }): PublicationStore;
  applySubjectPageDependencyDelta(tx: CommandTransaction, input: Delta): Promise<void>;
};
const dependencyType = 'com.rezics.semantic.subject_page.dependencies_changed.v1';
const repairType = 'com.rezics.semantic.subject_page.repair_requested.v1';
beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  real = await createRealAccess(db.admin, { editor }, actions, { clock });
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  app = createKernel({
    pool: db.pool,
    routeKey,
    clock,
    writeRate: real.writeRate,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(94)]]) },
    access(config) {
      access = real.access(config);
      return access;
    },
  });
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});
async function post(path: string, body: unknown, status = 200, key = randomUUID()) {
  const send = () =>
    app.handle(
      new Request(`http://kernel.test${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': `"${key}"`,
        },
        body: JSON.stringify(body),
      }),
    );
  let response = await send();
  let value = (await response.json()) as Record<string, any>;
  for (
    let retry = 0;
    retry < 2 &&
    response.status === 503 &&
    value.code === 'overloaded' &&
    value.retryable === true &&
    value.effect_status === 'not_applied';
    retry++
  ) {
    response = await send();
    value = (await response.json()) as Record<string, any>;
  }
  expect([path, response.status, response.status === status ? null : value]).toEqual([path, status, null]);
  return value;
}
const statement = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function person() {
  return (await post('/v1/subjects', { type: 'schema:Person', labels: { en: 'Foreign native owner' } }, 201)).subject;
}
async function book(target?: string) {
  return (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Dependent' },
        statements: {
          'schema:url': [statement('schema:url', 'https://example.test/survivor')],
          ...(target ? { 'schema:author': [statement('schema:author', target)] } : {}),
        },
      },
      201,
    )
  ).subject;
}
async function pair() {
  const owner = await person();
  let subject;
  do {
    subject = await book(owner.id);
  } while (partitionOf(routeOf(subject.id)!) === partitionOf(routeOf(owner.id)!));
  return { owner, subject };
}
async function ports(pool = db.pool) {
  // Genuine native commands above precede discovery; a scaffold cannot masquerade as a working Relay.
  const path = '../../src/semantic/subject-page-publication-relay.ts';
  const module = await import(path).catch(() => ({}));
  expect(typeof (module as any).createSubjectPagePublicationRelay, 'native dependency delivery adapter').toBe(
    'function',
  );
  const storePath = '../../src/semantic/subject-page-publication-store.ts';
  const stores = (await import(storePath).catch(() => ({}))) as StoreModule;
  expect(typeof stores.createSubjectPagePublicationStore).toBe('function');
  const runnerPath = '../../src/semantic/subject-page-publication.ts';
  const runners = await import(runnerPath).catch(() => ({}));
  expect(typeof (runners as any).createSubjectPagePublication).toBe('function');
  const input = { pool, access, clock, routeKey };
  const fresh = (): Relay => (module as any).createSubjectPagePublicationRelay(input);
  const relay = fresh();
  expect(Object.keys(relay).sort()).toEqual(['consumer', 'run']);
  expect(relay.consumer).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
  return {
    relay,
    fresh,
    stores,
    runner: (runners as any).createSubjectPagePublication(input) as PublicationRunner,
    store: stores.createSubjectPagePublicationStore(input),
  };
}
async function drainRelay(relay: Relay, partition: number) {
  for (let page = 0; page < 256; page++) {
    const result = await relay.run(partition);
    expect(result.status).toBe('read');
    if (result.status === 'read' && result.envelopes === 0) return;
  }
  throw new Error('Finite native source backlog did not drain');
}
async function drain(runner: PublicationRunner) {
  const cursors = new Set<string>();
  for (let page = 0; page < 16384; page++) {
    const result = await runner.step({ limit: 32 });
    expect(result.processed).toBeGreaterThanOrEqual(0);
    expect(result.processed).toBeLessThanOrEqual(32);
    expect(result.next === null).toBe(result.done);
    if (result.done) return;
    expect(cursors.has(result.next!)).toBe(false);
    cursors.add(result.next!);
  }
  throw new Error('Finite owner fanout and subject repair did not converge');
}
const key = (id: string): SubjectKey => ({ route: routeOf(id)!, id });
async function reverse(owner: Owner, subject: SubjectKey) {
  return (
    await db.admin.query(
      `SELECT * FROM semantic.subject_page_owner_dependency
    WHERE route=$1 AND owner_kind=$2 AND owner_key=$3 AND source_route=$4 AND source_subject_id=$5
    ORDER BY component_key`,
      [owner.route, owner.kind, owner.key, subject.route, subject.id],
    )
  ).rows;
}
async function observed(partition: number) {
  const events: CloudEvent[] = [];
  const consumer = `observe_${randomUUID().replaceAll('-', '')}`;
  for (let page = 0; page < 256; page++) {
    const result = await projectBatch(db.pool, {
      consumer,
      partition,
      async apply(envelopes) {
        events.push(...envelopes.flatMap((e) => e.events));
      },
    });
    expect(result.status).toBe('read');
    if (result.status === 'read' && result.envelopes === 0) return events;
  }
  throw new Error('Observer did not finish real source log');
}
async function checkpoint(relay: Relay, partition: number) {
  return (
    await db.admin.query(
      'SELECT epoch,position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
      [partition, relay.consumer],
    )
  ).rows;
}

// Only checkpoint transport is faulted. Every source read and destination transaction delegates unchanged.
// A size-one pool also makes holding a source checkout across a home change observably impossible.
function checkpointFault(pool: Pool) {
  const original = pool.connect.bind(pool);
  let armed = false;
  let failures = 0;
  (pool as any).connect = async () => {
    const client = await original();
    const query = client.query.bind(client);
    const release = client.release.bind(client);
    (client as any).query = (...args: any[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (armed && /UPDATE\s+core\.consumer_checkpoint/i.test(sql ?? '')) {
        armed = false;
        failures++;
        return Promise.reject(new Error('Injected loss after destination commit before checkpoint CAS'));
      }
      return (query as any)(...args);
    };
    client.release = (...args) => {
      client.query = query;
      client.release = release;
      release(...args);
    };
    return client;
  };
  return {
    arm() {
      armed = true;
    },
    count: () => failures,
  };
}

test('durable Relay delivers dependency and original-time owner changes with restart replay and late membership', async () => {
  at(1);
  const fixture = await pair();
  const subject = key(fixture.subject.id);
  const owner: Owner = { kind: 'subject', route: routeOf(fixture.owner.id)!, key: fixture.owner.id };
  const sourceHome = partitionOf(subject.route);
  const ownerHome = partitionOf(owner.route);
  expect(sourceHome).not.toBe(ownerHome);
  const transport = createPool(db.url);
  transport.options.max = 1;
  const fault = checkpointFault(transport);
  try {
    const p = await ports(transport);
    const native = await observed(sourceHome);
    expect(
      native.some((e) => e.type === dependencyType),
      'local hook emits native forward dependency outbox',
    ).toBe(true);
    // Initialize a checkpoint without manufacturing producer data.
    const before = await checkpoint(p.relay, sourceHome);
    fault.arm();
    await expect(p.relay.run(sourceHome)).rejects.toThrow(
      'Injected loss after destination commit before checkpoint CAS',
    );
    expect(fault.count()).toBe(1);
    const installed = await reverse(owner, subject);
    expect(installed.length).toBeGreaterThan(0);
    expect(installed.every((row) => row.route === owner.route && row.present)).toBe(true);
    const afterFailure = await checkpoint(p.relay, sourceHome);
    expect(afterFailure.map((row) => row.position)).toEqual(before.length ? before.map((row) => row.position) : ['0']);
    let restarted = p.fresh();
    expect(restarted).not.toBe(p.relay);
    expect(restarted.consumer).toBe(p.relay.consumer);
    await drainRelay(restarted, sourceHome);
    expect(await reverse(owner, subject)).toEqual(installed);
    expect(BigInt((await checkpoint(restarted, sourceHome))[0]!.position)).toBeGreaterThan(0n);
    await drain(p.runner);
    const removedAt = at(2);
    await post(`/v1/subjects/${owner.key}:hide`, { reason: 'Original owner change' });
    at(3);
    // Owner event consumption must enqueue fanout at the owner, never directly write the subject home.
    await drainRelay(restarted, ownerHome);
    const fanout = (
      await db.admin.query(
        `SELECT * FROM semantic.subject_page_fanout WHERE route=$1 AND owner_kind='subject' AND owner_key=$2`,
        [owner.route, owner.key],
      )
    ).rows;
    expect(fanout.length).toBeGreaterThan(0);
    await drain(p.runner);
    const requests = (await observed(ownerHome)).filter((e) => e.type === repairType);
    expect(requests.length, 'bounded fanout emits durable target handoff').toBeGreaterThan(0);
    // Inject the same crash at the second durable handoff, then recreate the adapter.
    fault.arm();
    await expect(restarted.run(ownerHome)).rejects.toThrow(
      'Injected loss after destination commit before checkpoint CAS',
    );
    const target = (
      await db.admin.query(`SELECT * FROM semantic.subject_page_repair WHERE route=$1 AND subject_id=$2`, [
        subject.route,
        subject.id,
      ])
    ).rows;
    expect(target).toHaveLength(1);
    restarted = p.fresh();
    await drainRelay(restarted, ownerHome);
    await drain(p.runner);
    expect((await p.store.readCurrent(subject))?.lastModified).toBe(removedAt);
    expect((await p.store.readCurrent(subject))?.id).toBe(subject.id); // Native URL still qualifies.

    // Delayed delivery of a forward dependency emitted before the owner changed.
    at(4);
    await post(`/v1/subjects/${owner.key}:restore`, { reason: 'New public period' });
    let late: SubjectKey;
    do {
      late = key((await book(owner.key)).id);
    } while (partitionOf(late.route) === ownerHome);
    const lateAt = at(5);
    await post(`/v1/subjects/${owner.key}:hide`, { reason: 'Before late membership arrives' });
    await drainRelay(restarted, ownerHome);
    await drain(p.runner); // Owner fanout completes without this membership.
    expect(await reverse(owner, late)).toEqual([]);
    const complete = (
      await db.admin.query(
        `SELECT state FROM semantic.subject_page_fanout WHERE route=$1 AND owner_kind='subject' AND owner_key=$2`,
        [owner.route, owner.key],
      )
    ).rows;
    expect(complete.length).toBeGreaterThan(0);
    expect(complete.every((row) => row.state === 'done')).toBe(true);
    const priorRequests = (await observed(ownerHome)).filter((e) => e.type === repairType).length;
    await drainRelay(restarted, partitionOf(late.route));
    expect((await reverse(owner, late)).some((row) => row.present)).toBe(true);
    expect((await observed(ownerHome)).filter((e) => e.type === repairType).length).toBeGreaterThan(priorRequests);
    await drainRelay(restarted, ownerHome);
    await drain(p.runner);
    expect((await p.store.readCurrent(late))?.lastModified).toBe(lateAt);
    for (let repeat = 0; repeat < 3; repeat++) {
      await drainRelay(restarted, sourceHome);
      await drainRelay(restarted, ownerHome);
      await drainRelay(restarted, partitionOf(late.route));
      expect(await p.runner.step({ limit: 32 })).toEqual({ processed: 0, next: null, done: true });
      expect((await p.store.readCurrent(late))?.lastModified).toBe(lateAt);
    }
  } finally {
    await transport.end();
  }
}, 240_000);

test('native removal deltas retain tombstones and older real membership cannot resurrect or advance time', async () => {
  at(11);
  const { owner: person, subject: book } = await pair();
  const subject = key(book.id);
  const owner: Owner = { kind: 'subject', route: routeOf(person.id)!, key: person.id };
  const p = await ports();
  await drainRelay(p.relay, partitionOf(subject.route));
  const initial = await reverse(owner, subject);
  expect(initial).toHaveLength(1);
  const membership = initial[0]!;
  const event = (await observed(partitionOf(subject.route))).find((e) => e.id === membership.event_id);
  expect(event?.type).toBe(dependencyType);
  const component = { kind: 'relation' as const, key: book.statements['schema:author'][0].id as string };
  at(12);
  await post(`/v1/subjects/${subject.id}/candidates/${component.key}:hide`, { reason: 'Remove dependency' });
  await drainRelay(p.relay, partitionOf(subject.route));
  const removed = await reverse(owner, subject);
  expect(removed).toHaveLength(1);
  expect(removed[0]!.present).toBe(false);
  expect(BigInt(removed[0]!.source_version)).toBeGreaterThan(BigInt(membership.source_version));
  const stable = await p.store.read(subject);
  const requestCount = (await observed(partitionOf(owner.route))).filter((e) => e.type === repairType).length;
  // Reapply the genuine earlier version via the exact store port used by Relay, without synthetic event truth.
  for (let repeat = 0; repeat < 2; repeat++)
    await runCommand(db.pool, { partition: partitionOf(owner.route), clock }, async (tx) => {
      const outbox: CommandEvent[] = [];
      await p.stores.applySubjectPageDependencyDelta(tx, {
        owner,
        subject,
        component,
        sourceVersion: String(membership.source_version),
        eventId: event!.id,
        present: true,
        time: { effectiveAt: new Date(origin + 11_000).toISOString(), evidence: 'known' },
        outbox,
      });
      expect(outbox).toEqual([]);
      return { value: null, events: outbox };
    });
  expect(await reverse(owner, subject)).toEqual(removed);
  expect(await p.store.read(subject)).toEqual(stable);
  expect((await observed(partitionOf(owner.route))).filter((e) => e.type === repairType)).toHaveLength(requestCount);
}, 120_000);

test('Content native original period evidence survives repeated takeDown, readFences and Relay delivery', async () => {
  at(21);
  const subject = await book();
  let externalId: string;
  do {
    externalId = randomUUID();
  } while (partitionOf(tupleRoute(routeKey, 'openlibrary', externalId)) === partitionOf(routeOf(subject.id)!));
  const source = {
    source: 'openlibrary',
    external_id: externalId,
    field_group: 'facts' as const,
    record_revision: '1',
    digest: 'a'.repeat(64),
    converter_revision: '1',
  };
  const batch = await post('/v1/subjects:batchWrite', {
    commands: [
      {
        op: 'propose',
        key: 'foreign',
        subject: subject.id,
        source,
        statement: {
          ...statement('schema:inLanguage', 'ja'),
          references: [{ parts: [statement('schema:url', 'https://example.test/import')] }],
        },
      },
    ],
  });
  expect(batch.results[0].status).toBe(201);
  const candidate = batch.results[0].value.candidate;
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  await post(`/v1/subjects/${subject.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: null,
  });
  const tuple = sourceTuple(routeKey, source);
  const p = await ports();
  await drainRelay(p.relay, partitionOf(routeOf(subject.id)!));
  const owner: Owner = { kind: 'source-fence', route: tuple.route, key: fenceKey(tuple) };
  expect((await reverse(owner, key(subject.id))).some((row) => row.present)).toBe(true);
  const removedAt = at(22);
  const input = { source: source.source, externalId, fieldGroup: 'facts', reason: 'Original period' };
  const receipt = randomUUID();
  await post('/v1/sourceFences:takedown', input, 200, receipt);
  const fence = (await readFences(db.admin, [tuple]))[0] as any;
  expect(fence.takenDown).toBe(true);
  expect(fence.takenDownAt, 'actual Content prerequisite retains original command time').toBe(removedAt);
  expect(fence.takedownId).toBeString();
  const eventType = 'com.rezics.content.source_fence.taken_down.v1';
  const original = (await observed(partitionOf(tuple.route))).filter(
    (e) => e.type === eventType && (e.data as any).external_id === externalId,
  );
  expect(original.length).toBeGreaterThan(0);
  expect(original[0]!.data).toMatchObject({
    field_group: 'facts',
    takenDownAt: removedAt,
    takedownId: fence.takedownId,
  });
  at(23);
  await post('/v1/sourceFences:takedown', input, 200, receipt);
  await post('/v1/sourceFences:takedown', input);
  expect((await readFences(db.admin, [tuple]))[0]).toMatchObject({
    takenDown: true,
    takenDownAt: removedAt,
    takedownId: fence.takedownId,
  });
  for (const event of (await observed(partitionOf(tuple.route))).filter(
    (e) => e.type === eventType && (e.data as any).external_id === externalId,
  ))
    expect(event.data).toMatchObject({ takenDownAt: removedAt, takedownId: fence.takedownId });
  await drainRelay(p.relay, partitionOf(tuple.route));
  await drain(p.runner);
  await drainRelay(p.fresh(), partitionOf(tuple.route));
  await drain(p.runner);
  expect((await p.store.readCurrent(key(subject.id)))?.lastModified).toBe(removedAt);
  const otherGroup = (await readFences(db.admin, [{ ...tuple, field_group: 'summary' }]))[0] as any;
  expect(otherGroup.takenDown).toBe(false);
  expect(Object.hasOwn(otherGroup, 'takenDownAt')).toBe(false);
  expect(Object.hasOwn(otherGroup, 'takedownId')).toBe(false);
}, 240_000);
