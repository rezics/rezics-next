import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool, type PoolClient } from 'pg';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from
  '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AdmissionUnavailable, engageAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { journalErasure, markErasureSuppressed } from '../../../services/main/src/modules/erasure/journal.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold, retainErasureCoverage,
  type BorrowedRestoreClients, type RestoredOwners } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { ensureModelGeneration } from '../../../services/main/src/modules/semantic/command.ts';
import { hash, initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { captureGraphRecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { fusekiSecrets, pinnedImage, qaStack, standaloneFuseki } from '../fault-recovery/search-ops-support.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

class DirectoryObjects implements ImmutableObjects {
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true }); }
  async put(bytes: Uint8Array): Promise<string> {
    const digest = hash(bytes);
    writeFileSync(join(this.directory, digest), bytes);
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    let bytes: Buffer;
    try { bytes = readFileSync(join(this.directory, digest)); }
    catch { throw new ObjectUnavailable('original fixture object is missing'); }
    if (hash(bytes) !== digest) throw new ObjectIntegrityError('original fixture object is corrupt');
    return bytes;
  }
}

let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let graph: Awaited<ReturnType<typeof standaloneFuseki>>;
let access: Pool, relay: Pool, account: Pool, content: Pool, writer: Pool;
let accessObserver: Client, relayObserver: Client;
let restored: RestoredOwners, consumer: string, generation: string;
let objects: DirectoryObjects, fuseki: FusekiClient;
let lineage: { dataEpoch: string; routingEpoch: string };
let qa: ReturnType<typeof qaStack>;
const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `borrowed-erasure-restore-${randomUUID()}`);
const volume = `rezics-borrowed-erasure-${randomUUID()}`;
const hmacKey = 'b7'.repeat(32);

beforeAll(async () => {
  const started = Date.now(), runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated QA integration tier');
  qa = qaStack(runId);
  databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content', 'relay']);
  const pool = (url: string) => new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1500 });
  access = pool(databases.urls.access); relay = pool(databases.urls.relay);
  account = pool(databases.urls.account); content = pool(databases.urls.content);
  await migrateContent(content);
  writer = pool(databases.urls.relay);
  accessObserver = new Client({ connectionString: databases.urls.access });
  relayObserver = new Client({ connectionString: databases.urls.relay });
  await accessObserver.connect(); await relayObserver.connect();
  graph = await standaloneFuseki(qa.dockerEnv, { name: volume, volume, image: pinnedImage(),
    secrets: fusekiSecrets(qa.composeEnv) });
  fuseki = new FusekiClient(graph.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);
  lineage = { dataEpoch: randomUUID(), routingEpoch: '1' };
  objects = new DirectoryObjects(join(directory, 'original-objects'));
  await initializeFreshGraph(fuseki, lineage);
  await ensureModelGeneration({ fuseki, lineage, objectDirectory: objects.directory, workObjects: objects });
  consumer = `borrowed-restore:${randomUUID()}`;
  await initializeRelayCheckpoint(relay, consumer, lineage.dataEpoch);
  for (let count = 0; count < 4; count++) {
    if (!await relayMainOutboxOnce(fuseki, relay, consumer)) break;
    if (count === 3) throw new Error('empty fixture relay drain exceeded its bound');
  }
  generation = await engageAccessRecoveryFence(access);
  restored = { access, account, content,
    graph: { fuseki, lineage }, objects: { directory: objects.directory, workObjects: objects } };
  expect(Date.now() - started).toBeLessThan(600_000);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([access?.end(), relay?.end(), account?.end(), content?.end(), writer?.end(),
    accessObserver?.end(), relayObserver?.end()]);
  graph?.remove();
  if (qa) {
    const { spawnSync } = await import('node:child_process');
    spawnSync('docker', ['volume', 'rm', '-f', volume], { env: qa.dockerEnv, timeout: 60_000 });
  }
  await databases?.close();
  rmSync(directory, { recursive: true, force: true });
}, 120_000);

async function capture(coverageConsumer = consumer) {
  const coverage = await captureGraphRecoveryCoverage(fuseki, account, access, relay,
    coverageConsumer, content, restored.objects);
  const authority = { sealedCoverage: JSON.stringify(sealRecoveryPayload(coverage, hmacKey,
    'graph-recovery-coverage')), hmacKey };
  await retainRecoveryCoverageHead(relay, authority.sealedCoverage, hmacKey);
  await retainErasureCoverage(relay, coverageConsumer);
  return authority;
}

async function identity(client: PoolClient) {
  return (await client.query<{ pid: number; transaction: string }>(
    'SELECT pg_backend_pid() AS pid, txid_current()::text AS transaction')).rows[0]!;
}

async function allocatorAvailable() {
  await relayObserver.query('BEGIN');
  try {
    return (await relayObserver.query<{ available: boolean }>(`SELECT pg_try_advisory_xact_lock(
      hashtextextended('rezics-relay-erasure-epoch', 0)) AS available`)).rows[0]!.available;
  } finally { await relayObserver.query('ROLLBACK'); }
}

async function withClients<T>(work: (clients: BorrowedRestoreClients) => Promise<T>) {
  const accessClient = await access.connect(), relayClient = await relay.connect();
  try {
    await accessClient.query('BEGIN'); await relayClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await accessClient.query("SET LOCAL lock_timeout = '11s'");
    await relayClient.query("SET LOCAL lock_timeout = '11s'");
    await accessClient.query("SET LOCAL statement_timeout = '13s'");
    await relayClient.query("SET LOCAL statement_timeout = '13s'");
    return await work({ accessClient, relayClient });
  } finally {
    await accessClient.query('ROLLBACK'); await relayClient.query('ROLLBACK');
    accessClient.release(); relayClient.release();
  }
}

test('full borrowed max-one restore preserves caller transactions and allocator through callback interruption, retry and Access release', async () => {
  const authority = await capture(), operationId = randomUUID();
  await withClients(async clients => {
    const accessIdentity = await identity(clients.accessClient), relayIdentity = await identity(clients.relayClient);
    const summary = await reconcileRestoredErasures(relay, restored,
      { operationId, consumer, replay: true, authority }, clients);
    expect(summary.state).toBe('reconciled');
    expect((await clients.relayClient.query('SELECT operation_id FROM relay.owner_reconciliation WHERE id = $1',
      [summary.reconciliationId])).rows[0].operation_id).toBe(`${operationId}:erasures`);
    expect((await relayObserver.query('SELECT 1 FROM relay.owner_reconciliation WHERE id = $1',
      [summary.reconciliationId])).rowCount).toBe(0);
    await clients.accessClient.query('SAVEPOINT before_release');
    await clients.relayClient.query('SAVEPOINT before_release');
    const principal = randomUUID();
    let callbacks = 0;
    const callback = async () => {
      callbacks++;
      expect(await identity(clients.accessClient)).toEqual(accessIdentity);
      expect(await identity(clients.relayClient)).toEqual(relayIdentity);
      expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
      expect(await allocatorAvailable()).toBe(false);
    };
    await expect(releaseErasureRestoreHold(relay, restored, summary.reconciliationId, generation, authority,
      { clients, beforeAccessRelease: async () => {
        await callback();
        await clients.accessClient.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
          VALUES ($1::uuid, 'https://borrowed-restore.test', $1::text)`, [principal]);
        throw new Error('caller graph release interruption');
      } })).rejects.toThrow('caller graph release interruption');
    expect(await identity(clients.accessClient)).toEqual(accessIdentity);
    expect(await allocatorAvailable()).toBe(false);
    await clients.accessClient.query('ROLLBACK TO SAVEPOINT before_release');
    await clients.relayClient.query('ROLLBACK TO SAVEPOINT before_release');
    await releaseErasureRestoreHold(relay, restored, summary.reconciliationId, generation, authority,
      { clients, beforeAccessRelease: callback });
    expect(callbacks).toBe(2);
    expect(await identity(clients.accessClient)).toEqual(accessIdentity);
    expect(await identity(clients.relayClient)).toEqual(relayIdentity);
    expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(true);
    expect((await accessObserver.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
    expect(await allocatorAvailable()).toBe(false);
    expect((await clients.accessClient.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('11s');
    expect((await clients.relayClient.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('13s');
  });
  expect(await allocatorAvailable()).toBe(true);
}, 30_000);

async function allocateObjectErasure(client: PoolClient) {
  const id = randomUUID();
  const epoch = (await client.query<{ epoch: string }>('SELECT relay.next_erasure_epoch()::text AS epoch')).rows[0]!.epoch;
  await client.query(`INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest,
    kind, authority, principal_id, admission_id, authority_epoch)
    VALUES ($1, $2, $3, $4, 'revision', 'access_admission', $5, $6, 0)`,
  [id, epoch, `writer:${id}`, hash(id), randomUUID(), randomUUID()]);
  await client.query(`INSERT INTO relay.erasure_target (erasure_id, ordinal, owner, target_kind, target_ref)
    VALUES ($1, 1, 'object', 'object', $2)`, [id, `sha256:${hash(`absent:${id}`)}`]);
  await markErasureSuppressed(client, id);
  return { id, epoch };
}

test('allocator acquisition precedes journal reads and READ COMMITTED sees the independently committed current erasure', async () => {
  const authority = await capture(), writerClient = await writer.connect();
  try {
    await writerClient.query('BEGIN');
    const entry = await allocateObjectErasure(writerClient);
    await withClients(async clients => {
      const relayIdentity = await identity(clients.relayClient);
      const pending = reconcileRestoredErasures(relay, restored,
        { operationId: randomUUID(), consumer, replay: true, authority }, clients);
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting = (await relayObserver.query(`SELECT wait_event_type = 'Lock' AS waiting
            FROM pg_stat_activity WHERE pid = $1`, [relayIdentity.pid])).rows[0]?.waiting === true;
          if (waiting) break;
          await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        await writerClient.query('COMMIT');
        const summary = await pending;
        expect(summary.state).toBe('reconciled');
        expect(summary.erasureEpoch).toBe(entry.epoch);
        expect(await identity(clients.relayClient)).toEqual(relayIdentity);
        expect(await allocatorAvailable()).toBe(false);
        await releaseErasureRestoreHold(relay, restored, summary.reconciliationId, generation, authority,
          { clients, beforeAccessRelease: async () => { expect(await allocatorAvailable()).toBe(false); } });
      } finally { await writerClient.query('ROLLBACK'); await pending.catch(() => undefined); }
    });
  } finally { await writerClient.query('ROLLBACK'); writerClient.release(); }
}, 30_000);

test('a newer independently retained journal frontier vetoes release before callback and a fresh reconciliation covers it', async () => {
  const authority = await capture();
  const summary = await withClients(async clients => {
    const result = await reconcileRestoredErasures(relay, restored,
      { operationId: randomUUID(), consumer, replay: true, authority }, clients);
    expect(result.state).toBe('reconciled');
    await clients.relayClient.query('COMMIT');
    return result;
  });
  const entry = await journalErasure(writer, { operationId: randomUUID(), requestDigest: hash(randomUUID()),
    kind: 'revision', principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '0',
    targets: [{ kind: 'object', ref: `sha256:${hash(randomUUID())}` }] });
  await markErasureSuppressed(writer, entry.erasureId);
  await withClients(async clients => {
    let callbacks = 0;
    await expect(releaseErasureRestoreHold(relay, restored, summary.reconciliationId, generation, authority,
      { clients, beforeAccessRelease: async () => { callbacks++; } }))
      .rejects.toThrow('a newer retained frontier needs reconciliation');
    expect(callbacks).toBe(0);
    const current = await reconcileRestoredErasures(relay, restored,
      { operationId: randomUUID(), consumer, replay: true, authority }, clients);
    expect(current.state).toBe('reconciled');
    expect(current.erasureEpoch).toBe(entry.erasureEpoch);
    await releaseErasureRestoreHold(relay, restored, current.reconciliationId, generation, authority,
      { clients, beforeAccessRelease: async () => { callbacks++; expect(await allocatorAvailable()).toBe(false); } });
    expect(callbacks).toBe(1);
  });
}, 30_000);

test('the held Access generation vetoes graph callback without changing the caller transaction', async () => {
  const authority = await capture();
  await withClients(async clients => {
    const before = await identity(clients.accessClient);
    const summary = await reconcileRestoredErasures(relay, restored,
      { operationId: randomUUID(), consumer, replay: true, authority }, clients);
    let callbacks = 0;
    await expect(releaseErasureRestoreHold(relay, restored, summary.reconciliationId,
      String(BigInt(generation) + 1n), authority,
      { clients, beforeAccessRelease: async () => { callbacks++; } })).rejects.toBeInstanceOf(AdmissionUnavailable);
    expect(callbacks).toBe(0);
    expect(await identity(clients.accessClient)).toEqual(before);
    expect(await allocatorAvailable()).toBe(false);
    expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
  });
}, 30_000);

async function seedDeliveringLease(kind: 'search' | 'download') {
  const principal = randomUUID(), actor = `https://rezics.com/id/${randomUUID()}`;
  const target = `https://rezics.com/id/${randomUUID()}`, representation = randomUUID(), grant = randomUUID(), id = randomUUID();
  const scope = `${kind === 'search' ? 'contribution' : 'work'}:read:${target}`;
  const action = kind === 'search' ? 'contribution.read' : 'work.read';
  await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1::uuid, 'https://borrowed-delivery.test', $1::text)`, [principal]);
  await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
  await access.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  await access.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [representation, principal, actor, action]);
  await access.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [grant, actor, scope, action]);
  const common = [id, principal, actor, target, scope, representation, grant, generation];
  if (kind === 'search') {
    await access.query(`INSERT INTO access.search_read_lease (id, principal_id, acting_subject, contribution,
      scope_id, representation_id, grant_id, authority_epoch, principal_epoch, recovery_generation,
      subject_generation, representation_generation, grant_generation, expires_at, state, delivery_started_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 0, 0, 0, now() + interval '1 hour', 'delivering', now())`, common);
  } else {
    await access.query(`INSERT INTO access.download_read_lease (id, principal_id, acting_subject, target,
      scope_id, representation_id, grant_id, authority_epoch, principal_epoch, recovery_generation,
      subject_generation, representation_generation, grant_generation, expires_at, state, delivery_started_at, asset_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 0, 0, 0, now() + interval '1 hour', 'delivering', now(), $9)`,
    [...common, randomUUID()]);
  }
  return id;
}

for (const kind of ['search', 'download'] as const) {
  test(`an active delivering ${kind} lease vetoes graph callback despite exact current authority`, async () => {
    const id = await seedDeliveringLease(kind);
    try {
      const authority = await capture();
      await withClients(async clients => {
        const summary = await reconcileRestoredErasures(relay, restored,
          { operationId: randomUUID(), consumer, replay: true, authority }, clients);
        expect(summary.state).toBe('reconciled');
        let callbacks = 0;
        await expect(releaseErasureRestoreHold(relay, restored, summary.reconciliationId, generation, authority,
          { clients, beforeAccessRelease: async () => { callbacks++; } }))
          .rejects.toThrow('Access delivery is still active');
        expect(callbacks).toBe(0);
        expect(await allocatorAvailable()).toBe(false);
        expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
      });
    } finally {
      await access.query(`UPDATE access.${kind === 'search' ? 'search' : 'download'}_read_lease
        SET state = 'aborted', finished_at = clock_timestamp() WHERE id = $1`, [id]);
    }
  }, 30_000);
}

for (const current of ['missing', 'superseded'] as const) {
  test(`${current} current retained authority vetoes release before graph callback`, async () => {
    const authority = await capture();
    const summary = await withClients(async clients => {
      const result = await reconcileRestoredErasures(relay, restored,
        { operationId: randomUUID(), consumer, replay: true, authority }, clients);
      expect(result.state).toBe('reconciled');
      await clients.relayClient.query('COMMIT');
      return result;
    });
    if (current === 'missing') await relay.query('DELETE FROM relay.current_authority_coverage WHERE id');
    else {
      const nextConsumer = `borrowed-current:${randomUUID()}`;
      await initializeRelayCheckpoint(relay, nextConsumer, lineage.dataEpoch);
      for (let count = 0; count < 4; count++) {
        if (!await relayMainOutboxOnce(fuseki, relay, nextConsumer)) break;
        if (count === 3) throw new Error('current authority relay drain exceeded its bound');
      }
      await capture(nextConsumer);
    }
    await withClients(async clients => {
      let callbacks = 0;
      await expect(releaseErasureRestoreHold(relay, restored, summary.reconciliationId, generation, authority,
        { clients, beforeAccessRelease: async () => { callbacks++; } }))
        .rejects.toThrow('restored Access differs from current retained authority');
      expect(callbacks).toBe(0);
      expect(await allocatorAvailable()).toBe(false);
      expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
    });
  }, 30_000);
}

for (const mode of ['repeatable-read relay', 'idle relay', 'idle Access'] as const) {
  test(`borrowed ${mode} denies reconciliation and release without taking caller lifecycle`, async () => {
    const authority = await capture(), operationId = randomUUID();
    await withClients(async clients => {
      if (mode === 'repeatable-read relay') {
        await clients.relayClient.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      } else await (mode === 'idle relay' ? clients.relayClient : clients.accessClient).query('COMMIT');
      const message = mode === 'repeatable-read relay' ? 'retained relay needs a fresh READ COMMITTED view'
        : mode === 'idle relay' ? 'retained relay transaction is not held' : 'restored Access transaction is not held';
      await expect(reconcileRestoredErasures(relay, restored,
        { operationId, consumer, replay: true, authority }, clients)).rejects.toThrow(message);
      let callbacks = 0;
      await expect(releaseErasureRestoreHold(relay, restored, randomUUID(), generation, authority,
        { clients, beforeAccessRelease: async () => { callbacks++; } })).rejects.toThrow(message);
      expect(callbacks).toBe(0);
      expect((await clients.relayClient.query('SELECT 1 FROM relay.owner_reconciliation WHERE operation_id = $1',
        [`${operationId}:erasures`])).rowCount).toBe(0);
      expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
      for (const [client, observer, idle] of [[clients.relayClient, relayObserver, mode === 'idle relay'],
        [clients.accessClient, accessObserver, mode === 'idle Access']] as const) {
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        expect((await observer.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0].state)
          .toBe(idle ? 'idle' : 'idle in transaction');
      }
      expect(access.totalCount).toBe(1);
      expect(relay.totalCount).toBe(1);
    });
    expect(await allocatorAvailable()).toBe(true);
  }, 30_000);
}

test('a callback committing the supplied relay loses authorization before Access CAS and leaves Access caller-owned', async () => {
  const authority = await capture();
  await withClients(async clients => {
    const accessIdentity = await identity(clients.accessClient);
    const summary = await reconcileRestoredErasures(relay, restored,
      { operationId: randomUUID(), consumer, replay: true, authority }, clients);
    expect(summary.state).toBe('reconciled');
    let callbacks = 0;
    await expect(releaseErasureRestoreHold(relay, restored, summary.reconciliationId, generation, authority,
      { clients, beforeAccessRelease: async () => {
        callbacks++;
        expect(await allocatorAvailable()).toBe(false);
        await clients.relayClient.query('COMMIT');
      } })).rejects.toThrow('owner release callback changed a held transaction');
    expect(callbacks).toBe(1);
    expect(await identity(clients.accessClient)).toEqual(accessIdentity);
    expect((await clients.accessClient.query('SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id')).rows)
      .toEqual([{ open: false, generation }]);
    expect((await accessObserver.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
    expect(await allocatorAvailable()).toBe(true);
  });
}, 30_000);

async function committedReconciliation(authority: Awaited<ReturnType<typeof capture>>) {
  const result = await withClients(async clients => {
    const summary = await reconcileRestoredErasures(relay, restored,
      { operationId: randomUUID(), consumer, replay: true, authority }, clients);
    expect(summary.state).toBe('reconciled');
    // The caller retains the successful helper record while Access stays closed.
    await clients.relayClient.query('COMMIT');
    return summary;
  });
  expect((await relayObserver.query('SELECT state FROM relay.owner_reconciliation WHERE id = $1',
    [result.reconciliationId])).rows).toEqual([{ state: 'reconciled' }]);
  return result;
}

async function reconciliationSnapshot(id: string) {
  return {
    header: (await relayObserver.query('SELECT * FROM relay.owner_reconciliation WHERE id = $1', [id])).rows,
    cuts: (await relayObserver.query(`SELECT * FROM relay.owner_reconciliation_cut
      WHERE reconciliation_id = $1 ORDER BY owner`, [id])).rows,
    items: (await relayObserver.query(`SELECT * FROM relay.owner_reconciliation_item
      WHERE reconciliation_id = $1 ORDER BY ordinal`, [id])).rows,
  };
}

test('a reconstructed identical lineage authenticates the committed record independently of object property order', async () => {
  const authority = await capture(), summary = await committedReconciliation(authority);
  const original = await reconciliationSnapshot(summary.reconciliationId);
  const graph = restored.graph!;
  const reconstructed = { ...restored, graph: { ...graph,
    lineage: { routingEpoch: graph.lineage.routingEpoch, dataEpoch: graph.lineage.dataEpoch } } };
  await withClients(async clients => {
    let callbacks = 0;
    await releaseErasureRestoreHold(relay, reconstructed, summary.reconciliationId, generation, authority,
      { clients, beforeAccessRelease: async () => { callbacks++; expect(await allocatorAvailable()).toBe(false); } });
    expect(callbacks).toBe(1);
    expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(true);
    expect((await accessObserver.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
  });
  expect(await reconciliationSnapshot(summary.reconciliationId)).toEqual(original);
  expect(await allocatorAvailable()).toBe(true);
}, 30_000);

async function deniedRelease(clients: BorrowedRestoreClients, id: string,
  authority: Awaited<ReturnType<typeof capture>>, owners = restored, heldGeneration = generation) {
  const accessIdentity = await identity(clients.accessClient), relayIdentity = await identity(clients.relayClient);
  let callbacks = 0;
  await expect(releaseErasureRestoreHold(relay, owners, id, heldGeneration, authority,
    { clients, beforeAccessRelease: async () => { callbacks++; } })).rejects.toBeInstanceOf(ErasureRestoreHold);
  expect(callbacks).toBe(0);
  expect(await identity(clients.accessClient)).toEqual(accessIdentity);
  expect(await identity(clients.relayClient)).toEqual(relayIdentity);
  expect((await clients.accessClient.query(`SELECT open, generation::text AS generation
    FROM access.recovery_fence WHERE id`)).rows).toEqual([{ open: false, generation: heldGeneration }]);
  expect((await accessObserver.query(`SELECT open, generation::text AS generation
    FROM access.recovery_fence WHERE id`)).rows).toEqual([{ open: false, generation }]);
  expect(await allocatorAvailable()).toBe(false);
  for (const client of [clients.accessClient, clients.relayClient]) {
    expect((await client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('11s');
    expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('13s');
  }
  expect(access.totalCount).toBe(1);
  expect(relay.totalCount).toBe(1);
}

type RetainedCorruption = { name: string; tables: readonly string[]; statements: readonly string[] };
const retainedCorruptions: readonly RetainedCorruption[] = [
  { name: 'missing prior record', tables: ['owner_reconciliation_item', 'owner_reconciliation_cut', 'owner_reconciliation'],
    statements: ['DELETE FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1',
      'DELETE FROM relay.owner_reconciliation_cut WHERE reconciliation_id = $1',
      'DELETE FROM relay.owner_reconciliation WHERE id = $1'] },
  { name: 'wrong kind', tables: ['owner_reconciliation'], statements: [
    "UPDATE relay.owner_reconciliation SET kind = 'revision_recovery' WHERE id = $1"] },
  { name: 'wrong scope', tables: ['owner_reconciliation'], statements: [
    "UPDATE relay.owner_reconciliation SET scope = scope || ':other' WHERE id = $1"] },
  { name: 'foreign operation namespace', tables: ['owner_reconciliation'], statements: [
    "UPDATE relay.owner_reconciliation SET operation_id = 'foreign:' || id::text WHERE id = $1"] },
  { name: 'another erasure operation', tables: ['owner_reconciliation'], statements: [
    "UPDATE relay.owner_reconciliation SET operation_id = 'other:' || id::text || ':erasures' WHERE id = $1"] },
  { name: 'unfinished prior outcome', tables: ['owner_reconciliation'], statements: [
    "UPDATE relay.owner_reconciliation SET state = 'running', completed_at = NULL WHERE id = $1"] },
  { name: 'wrong request digest', tables: ['owner_reconciliation'], statements: [
    "UPDATE relay.owner_reconciliation SET request_digest = repeat('0', 64) WHERE id = $1"] },
  { name: 'corrupt outcome digest', tables: ['owner_reconciliation'], statements: [
    "UPDATE relay.owner_reconciliation SET outcome_digest = repeat('0', 64) WHERE id = $1"] },
  { name: 'foreign partial format binding', tables: ['owner_reconciliation'], statements: [
    "UPDATE relay.owner_reconciliation SET format_from = 'foreign' WHERE id = $1"] },
  { name: 'corrupt item evidence', tables: ['owner_reconciliation_item'], statements: [
    `UPDATE relay.owner_reconciliation_item SET evidence_digest = repeat('0', 64)
      WHERE reconciliation_id = $1 AND ordinal = 1`] },
  { name: 'changed generation finding', tables: ['owner_reconciliation_item'], statements: [
    `UPDATE relay.owner_reconciliation_item SET item_ref = item_ref || ':other'
      WHERE reconciliation_id = $1 AND owner = 'access' AND item_kind = 'authority_fence'
        AND item_ref LIKE 'restore-access-generation:%'`] },
  { name: 'unresolved item disposition', tables: ['owner_reconciliation_item'], statements: [
    `UPDATE relay.owner_reconciliation_item SET disposition = 'corrupt'
      WHERE reconciliation_id = $1 AND ordinal = 1`] },
  { name: 'missing first ordered finding', tables: ['owner_reconciliation_item'], statements: [
    'DELETE FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1 AND ordinal = 1'] },
  { name: 'missing final finding', tables: ['owner_reconciliation_item'], statements: [
    `DELETE FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1 AND ordinal =
      (SELECT max(ordinal) FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1)`] },
  { name: 'empty findings', tables: ['owner_reconciliation_item'], statements: [
    'DELETE FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1'] },
  { name: 'missing owner cut', tables: ['owner_reconciliation_cut'], statements: [
    "DELETE FROM relay.owner_reconciliation_cut WHERE reconciliation_id = $1 AND owner = 'account'"] },
  { name: 'extra owner cut', tables: ['owner_reconciliation_cut'], statements: [
    `INSERT INTO relay.owner_reconciliation_cut (reconciliation_id, owner, coverage_digest, status)
      SELECT reconciliation_id, 'source', coverage_digest, status FROM relay.owner_reconciliation_cut
      WHERE reconciliation_id = $1 AND owner = 'account'`] },
  { name: 'unmatched owner cut', tables: ['owner_reconciliation_cut'], statements: [
    "UPDATE relay.owner_reconciliation_cut SET status = 'mismatch' WHERE reconciliation_id = $1 AND owner = 'access'"] },
  { name: 'corrupt owner cut evidence', tables: ['owner_reconciliation_cut'], statements: [
    `UPDATE relay.owner_reconciliation_cut SET coverage_digest = repeat('0', 64)
      WHERE reconciliation_id = $1 AND owner = 'account'`] },
  { name: 'foreign owner position', tables: ['owner_reconciliation_cut'], statements: [
    `UPDATE relay.owner_reconciliation_cut SET data_epoch = 'foreign', sequence = 1
      WHERE reconciliation_id = $1 AND owner = 'access'`] },
  { name: 'foreign owner cluster and WAL', tables: ['owner_reconciliation_cut'], statements: [
    `UPDATE relay.owner_reconciliation_cut SET cluster_id = '1', wal_lsn = '0/1'::pg_lsn
      WHERE reconciliation_id = $1 AND owner = 'account'`] },
  { name: 'foreign owner format', tables: ['owner_reconciliation_cut'], statements: [
    `UPDATE relay.owner_reconciliation_cut SET format_version = 'foreign'
      WHERE reconciliation_id = $1 AND owner = 'account'`] },
  { name: 'changed Content cut epoch', tables: ['owner_reconciliation_cut'], statements: [
    `UPDATE relay.owner_reconciliation_cut SET data_epoch = 'foreign'
      WHERE reconciliation_id = $1 AND owner = 'content'`] },
  { name: 'changed graph cut sequence', tables: ['owner_reconciliation_cut'], statements: [
    `UPDATE relay.owner_reconciliation_cut SET sequence = sequence + 1
      WHERE reconciliation_id = $1 AND owner = 'graph'`] },
];

test('release authenticates the entire committed prior record, ordered findings, outcome and all owner cuts', async () => {
  const authority = await capture(), summary = await committedReconciliation(authority);
  const original = await reconciliationSnapshot(summary.reconciliationId);
  expect(original.cuts).toHaveLength(6);
  expect(original.items.length).toBeGreaterThanOrEqual(5);
  await withClients(async clients => {
    for (const corruption of retainedCorruptions) {
      await clients.relayClient.query('SAVEPOINT retained_corruption');
      // Only this isolated clone permits corruption; production sees active guards.
      for (const table of corruption.tables) await clients.relayClient.query(`ALTER TABLE relay.${table} DISABLE TRIGGER USER`);
      for (const statement of corruption.statements) {
        expect((await clients.relayClient.query(statement, [summary.reconciliationId])).rowCount,
          corruption.name).toBeGreaterThan(0);
      }
      for (const table of corruption.tables) await clients.relayClient.query(`ALTER TABLE relay.${table} ENABLE TRIGGER USER`);
      await deniedRelease(clients, summary.reconciliationId, authority);
      await clients.relayClient.query('ROLLBACK TO SAVEPOINT retained_corruption');
      await clients.relayClient.query('RELEASE SAVEPOINT retained_corruption');
      expect(await reconciliationSnapshot(summary.reconciliationId), corruption.name).toEqual(original);
    }
    let callbacks = 0;
    await releaseErasureRestoreHold(relay, restored, summary.reconciliationId, generation, authority,
      { clients, beforeAccessRelease: async () => { callbacks++; expect(await allocatorAvailable()).toBe(false); } });
    expect(callbacks).toBe(1);
    expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(true);
    expect((await accessObserver.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
  });
  expect(await reconciliationSnapshot(summary.reconciliationId)).toEqual(original);
  expect(await allocatorAvailable()).toBe(true);
}, 90_000);

test('unchanged journal maximum and coverage generation cannot hide changed old intent, targets or retained head evidence', async () => {
  const entries: Awaited<ReturnType<typeof journalErasure>>[] = [];
  for (let count = 0; count < 2; count++) {
    const entry = await journalErasure(writer, { operationId: randomUUID(), requestDigest: hash(randomUUID()),
      kind: 'revision', principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '0',
      targets: [{ kind: 'object', ref: `sha256:${hash(randomUUID())}` }] });
    await markErasureSuppressed(writer, entry.erasureId);
    entries.push(entry);
  }
  const authority = await capture(), summary = await committedReconciliation(authority);
  const original = await reconciliationSnapshot(summary.reconciliationId);
  const facts = async () => ({
    head: (await relayObserver.query('SELECT * FROM relay.recovery_coverage_head WHERE consumer = $1', [consumer])).rows,
    intent: (await relayObserver.query('SELECT * FROM relay.erasure WHERE id = $1', [entries[0]!.erasureId])).rows,
    targets: (await relayObserver.query('SELECT * FROM relay.erasure_target WHERE erasure_id = $1 ORDER BY ordinal',
      [entries[0]!.erasureId])).rows,
  });
  const originalFacts = await facts();
  await withClients(async clients => {
    const frontier = async () => (await clients.relayClient.query(`SELECT generation::text,
      (SELECT max(erasure_epoch)::text FROM relay.erasure) AS maximum
      FROM relay.recovery_coverage_head WHERE consumer = $1`, [consumer])).rows;
    const before = await frontier();
    expect(before[0].maximum).toBe(entries[1]!.erasureEpoch);
    for (const corruption of [
      { table: 'erasure', statement: "UPDATE relay.erasure SET request_digest = repeat('0', 64) WHERE id = $1",
        value: entries[0]!.erasureId },
      { table: 'erasure_target', statement: `UPDATE relay.erasure_target SET target_ref = 'sha256:' || repeat('0', 64)
        WHERE erasure_id = $1 AND ordinal = 1`, value: entries[0]!.erasureId },
      { table: 'recovery_coverage_head', statement: `UPDATE relay.recovery_coverage_head
        SET coverage_digest = repeat('0', 64) WHERE consumer = $1`, value: consumer },
      { table: 'recovery_coverage_head', statement: `UPDATE relay.recovery_coverage_head
        SET erasure_epoch = (SELECT erasure_epoch FROM relay.erasure WHERE id = $2)
        WHERE consumer = $1`, value: consumer, epoch: entries[0]!.erasureId },
      { table: 'recovery_coverage_head', statement: `UPDATE relay.recovery_coverage_head
        SET captured_at = captured_at + interval '1 second' WHERE consumer = $1`, value: consumer },
    ]) {
      await clients.relayClient.query('SAVEPOINT journal_corruption');
      await clients.relayClient.query(`ALTER TABLE relay.${corruption.table} DISABLE TRIGGER USER`);
      const values = 'epoch' in corruption ? [corruption.value, corruption.epoch] : [corruption.value];
      expect((await clients.relayClient.query(corruption.statement, values)).rowCount).toBe(1);
      await clients.relayClient.query(`ALTER TABLE relay.${corruption.table} ENABLE TRIGGER USER`);
      expect(await frontier()).toEqual(before);
      await deniedRelease(clients, summary.reconciliationId, authority);
      await clients.relayClient.query('ROLLBACK TO SAVEPOINT journal_corruption');
      await clients.relayClient.query('RELEASE SAVEPOINT journal_corruption');
      expect(await facts()).toEqual(originalFacts);
      expect(await reconciliationSnapshot(summary.reconciliationId)).toEqual(original);
    }
  });
  expect(await allocatorAvailable()).toBe(true);
}, 45_000);

test('a new valid closed Access generation cannot borrow an older committed reconciliation', async () => {
  const authority = await capture(), summary = await committedReconciliation(authority);
  const original = await reconciliationSnapshot(summary.reconciliationId);
  await withClients(async clients => {
    await clients.accessClient.query('SAVEPOINT changed_generation');
    const next = (await clients.accessClient.query<{ generation: string }>(`UPDATE access.recovery_fence
      SET generation = generation + 1 WHERE id AND NOT open RETURNING generation::text`)).rows[0]!.generation;
    expect(next).toBe(String(BigInt(generation) + 1n));
    await deniedRelease(clients, summary.reconciliationId, authority, restored, next);
    await clients.accessClient.query('ROLLBACK TO SAVEPOINT changed_generation');
    expect((await clients.accessClient.query(`SELECT open, generation::text AS generation
      FROM access.recovery_fence WHERE id`)).rows).toEqual([{ open: false, generation }]);
  });
  expect(await reconciliationSnapshot(summary.reconciliationId)).toEqual(original);
  expect(await allocatorAvailable()).toBe(true);
}, 30_000);

for (const position of ['data epoch', 'sequence'] as const) {
  test(`changed actual Content ${position} refuses the prior committed reconciliation before callback`, async () => {
    const authority = await capture(), summary = await committedReconciliation(authority);
    const original = await reconciliationSnapshot(summary.reconciliationId);
    const before = (await content.query<{ data_epoch: string; sequence: string }>(
      'SELECT data_epoch::text, sequence::text FROM content.owner_control WHERE singleton')).rows[0]!;
    try {
      if (position === 'data epoch') await content.query('UPDATE content.owner_control SET data_epoch = $1 WHERE singleton', [randomUUID()]);
      else await content.query('UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton');
      await withClients(clients => deniedRelease(clients, summary.reconciliationId, authority));
    } finally {
      await content.query('UPDATE content.owner_control SET data_epoch = $1, sequence = $2 WHERE singleton',
        [before.data_epoch, before.sequence]);
    }
    expect((await content.query('SELECT data_epoch::text, sequence::text FROM content.owner_control WHERE singleton')).rows)
      .toEqual([before]);
    expect(await reconciliationSnapshot(summary.reconciliationId)).toEqual(original);
    expect(await allocatorAvailable()).toBe(true);
  }, 30_000);
}

for (const change of ['data epoch', 'routing epoch'] as const) {
  test(`changed restored graph ${change} refuses a prior record against the same actual native graph`, async () => {
    const authority = await capture(), summary = await committedReconciliation(authority);
    const original = await reconciliationSnapshot(summary.reconciliationId);
    const changed: RestoredOwners = { ...restored, graph: { ...restored.graph!, lineage: {
      ...lineage, ...(change === 'data epoch' ? { dataEpoch: randomUUID() }
        : { routingEpoch: String(BigInt(lineage.routingEpoch) + 1n) }),
    } } };
    await withClients(clients => deniedRelease(clients, summary.reconciliationId, authority, changed));
    expect(await reconciliationSnapshot(summary.reconciliationId)).toEqual(original);
    expect(await allocatorAvailable()).toBe(true);
  }, 30_000);
}
