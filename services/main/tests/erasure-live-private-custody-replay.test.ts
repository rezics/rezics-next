import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { type CommandEnvelope, type CommandResult, type CommandValidation, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody,
  type CustodyPayloadErasure, type SlimEnvelope } from '../src/modules/outbox/receipt-custody.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { GRAPHS, hash, prepareWorkComponent } from '../src/modules/work/activate.ts';
import { METADATA_PROFILE, metadataDigest, type MetadataEditionState } from '../src/modules/work/metadata-schema.ts';

interface Proof {
  digest: string; payloadSha256: string; dataEpoch: string; sequence: string; streamSequence: string;
}

class MemoryObjects implements ImmutableObjects {
  bytes = new Map<string, Uint8Array>();
  gets = 0;
  puts = 0;
  async put(bytes: Uint8Array): Promise<string> {
    this.puts++;
    const digest = hash(bytes);
    this.bytes.set(digest, Uint8Array.from(bytes));
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    this.gets++;
    const bytes = this.bytes.get(digest);
    if (!bytes) throw new ObjectUnavailable('exact source object missing');
    return Uint8Array.from(bytes);
  }
}

async function migrateAccess(pool: Pool): Promise<void> {
  const root = resolve(import.meta.dir, '../../..');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      for (const file of schemaFiles(root, 'access')) {
        await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally { client.release(); }
}

async function commandFixture(objects: MemoryObjects) {
  const receipt = `urn:rezics:receipt:${randomUUID()}`;
  const component = `https://rezics.com/id/${randomUUID()}`;
  const revision = `https://rezics.com/id/${randomUUID()}`;
  const work = `https://rezics.com/id/${randomUUID()}`;
  const state: MetadataEditionState = { kind: 'edition', id: component, status: 'active',
    title: { value: 'Measured edition', language: 'en' }, contentLanguage: 'en',
    editionStatement: 'First edition', publisher: 'Fixture Press', publicationYear: 2026, isbn13: '9780306406157' };
  const digest = metadataDigest({ work, expectedHead: null, state });
  const manifest = `urn:rezics:sha256:${await prepareWorkComponent(objects, component,
    { revision, intent: { work, expectedHead: null, state } }, METADATA_PROFILE)}`;
  const validations: CommandValidation[] = [
    { profile: 'work-metadata-details-v1', sha256: profileRegistry['work-metadata-details-v1'].sha256,
      shape: `${METADATA_PROFILE}/work-shape`, focus: [work], graphs: [GRAPHS.current, GRAPHS.revisions] },
    ...(['component', 'revision'] as const).map(role => ({ profile: 'work-metadata-details-v1',
      sha256: profileRegistry['work-metadata-details-v1'].sha256,
      shape: `${METADATA_PROFILE}/${role}-shape`, focus: [role === 'component' ? component : revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] })),
  ];
  for (const profileName of new Set(validations.map(value => value.profile))) {
    const entry = profileRegistry[profileName as keyof typeof profileRegistry];
    const shape = readFileSync(new URL(`../../../generated/model/${entry.file}`, import.meta.url));
    expect(await objects.put(shape)).toBe(entry.sha256);
  }
  const envelope: CommandEnvelope = { receipt, digest, update: 'bounded edition update', validations, deadlineMs: 10_000 };
  return { receipt, revision, digest, envelope, component, manifest, state, work,
    input: { envelope, component, revision, manifest, routingEpoch: 'routing-a', state,
      receipt: { outcome: 'succeeded' as const, receipt, admissionId: randomUUID(), requestDigest: digest,
        authorityEpoch: '8', scope: `work:edit:${work}`, dataEpoch: 'epoch-a', work, component, revision,
        predecessor: component } } };
}

function makeCustody(pool: Pool, objects: MemoryObjects, proof: { value: Proof | null },
  nativeQueries: string[], retirements: unknown[]) {
  const store = new PostgresReceiptCustodyStore(pool);
  const custody = new ReceiptCustody(store, objects, { query: async (query): Promise<SparqlResult> => {
    nativeQueries.push(query);
    if (!proof.value) return { results: { bindings: [] } };
    return { results: { bindings: [{ digest: { type: 'literal', value: proof.value.digest },
      payload: { type: 'literal', value: proof.value.payloadSha256 }, epoch: { type: 'literal', value: proof.value.dataEpoch },
      sequence: { type: 'literal', value: proof.value.sequence },
      streamSequence: { type: 'literal', value: proof.value.streamSequence } }] } };
  } }, 'a'.repeat(64), async value => { retirements.push(value); proof.value = null; });
  return { store, custody };
}

function committed(proof: { value: Proof | null }, counters: { dispatches: number },
  gate?: Promise<void>, signal?: () => void): (envelope: CommandEnvelope) => Promise<CommandResult> {
  return async envelope => {
    counters.dispatches++;
    signal?.();
    if (gate) await gate;
    const slim = envelope as SlimEnvelope;
    proof.value = { digest: envelope.digest, payloadSha256: slim.slim.payloadSha256,
      dataEpoch: 'epoch-a', sequence: '17', streamSequence: '4' };
    return { status: 'committed', position: { datasetId: 'urn:rezics:dataset:product',
      dataEpoch: 'epoch-a', sequence: '17' } };
  };
}

async function waitUntilBlocked(observer: Pool, waiterPid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const blockers = (await observer.query<{ blockers: number[] }>(
      'SELECT pg_blocking_pids($1) AS blockers', [waiterPid])).rows[0]?.blockers ?? [];
    if (blockers.length > 0) return true;
    await new Promise(resolveWait => setTimeout(resolveWait, 15));
  } while (Date.now() < deadline);
  return false;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} exceeded ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test('terminal erased custody serves receipt retries without restoring the command or relaxing retirement checks', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 3, connectionTimeoutMillis: 1_000 });
  const objects = new MemoryObjects();
  const proof = { value: null as Proof | null };
  const nativeQueries: string[] = [], retirements: unknown[] = [];
  const { store, custody } = makeCustody(pool, objects, proof, nativeQueries, retirements);
  const fixture = await commandFixture(objects);
  const counters = { dispatches: 0 };
  try {
    await migrateAccess(pool);
    const first = await custody.commit({ ...fixture.input, dispatch: committed(proof, counters) });
    expect(first).toEqual({ status: 'committed', position: {
      datasetId: 'urn:rezics:dataset:product', dataEpoch: 'epoch-a', sequence: '17' } });
    expect(counters.dispatches).toBe(1);
    const source = await custody.readCommitted(fixture.receipt);
    const payloadSha256 = source!.payloadSha256;
    expect(payloadSha256).toBe((await pool.query<{ payload_sha256: string }>(
      'SELECT payload_sha256 FROM access.command_custody WHERE receipt=$1', [fixture.receipt])).rows[0]!.payload_sha256);

    // Verification and normal retirement still require their exact originals.
    const commandBytes = objects.bytes.get(payloadSha256)!;
    objects.bytes.delete(payloadSha256);
    await expect(custody.readCommitted(fixture.receipt)).rejects.toBeInstanceOf(ObjectUnavailable);
    await expect(custody.retire(fixture.receipt)).rejects.toBeInstanceOf(ObjectUnavailable);
    expect(retirements).toHaveLength(0);
    objects.bytes.set(payloadSha256, commandBytes);
    await custody.retire(fixture.receipt);
    expect(retirements).toHaveLength(1);
    expect((await custody.readCommitted(fixture.receipt))?.payloadSha256).toBe(payloadSha256);

    const erasure: CustodyPayloadErasure = { revision: fixture.revision, payloadSha256,
      erasureId: randomUUID(), erasureEpoch: '12' };
    await store.withReceipt(fixture.receipt, async session => {
      if (!session.clearPayloadForErasure) throw new Error('PostgreSQL custody erase capability is unavailable');
      await session.clearPayloadForErasure(erasure);
    });
    expect((await pool.query<{ payload: Buffer | null; payload_erasure_id: string | null;
      payload_erasure_epoch: string | null }>(`SELECT payload,payload_erasure_id,
      payload_erasure_epoch::text AS payload_erasure_epoch FROM access.command_custody WHERE receipt=$1`,
    [fixture.receipt])).rows[0]).toEqual({ payload: null, payload_erasure_id: erasure.erasureId,
      payload_erasure_epoch: erasure.erasureEpoch });

    objects.bytes.clear();
    proof.value = { digest: 'b'.repeat(64), payloadSha256: 'c'.repeat(64), dataEpoch: 'stale-epoch',
      sequence: '3', streamSequence: '2' };
    const nativeQueryCount = nativeQueries.length, objectGetCount = objects.gets, objectPutCount = objects.puts;
    const terminal = await custody.resolve(fixture.receipt);
    expect(terminal).toMatchObject({ receipt: fixture.receipt, requestDigest: fixture.digest,
      dataEpoch: 'epoch-a', sequence: '17', streamSequence: '4' });
    expect(await custody.commit({ ...fixture.input, dispatch: async () => {
      counters.dispatches++;
      throw new Error('erased command custody must never dispatch');
    } })).toEqual(first);
    let cancellations = 0;
    expect(await custody.guardCancellation(fixture.receipt, async () => { cancellations++; }))
      .toEqual(terminal);
    expect(cancellations).toBe(0);
    expect(await custody.readCommitted(fixture.receipt)).toBeNull();
    const historicalClient = await pool.connect();
    try {
      expect(await custody.readHistorical({ dataEpoch: 'epoch-a', streamSequence: '4' }, historicalClient)).toBeNull();
    } finally { historicalClient.release(); }

    const outbox = await custody.read('epoch-a', '4');
    expect(outbox?.batch).toMatchObject({ custodiedReceipt: fixture.receipt, dataEpoch: 'epoch-a',
      sequence: '4', graphSequence: '17', streamScope: MAIN_RELAY_STREAM_SCOPE });
    await expect(custody.retire(fixture.receipt)).rejects.toBeInstanceOf(ObjectIntegrityError);
    expect(retirements).toHaveLength(1);
    expect(nativeQueries).toHaveLength(nativeQueryCount);
    expect(objects.gets).toBe(objectGetCount);
    expect(objects.puts).toBe(objectPutCount);
    expect(counters.dispatches).toBe(1);
  } finally {
    await pool.end();
    cluster.remove();
  }
}, 60_000);

test('erasure waits for a pending command to settle under the same receipt lock', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 4, connectionTimeoutMillis: 1_000 });
  const observer = new Pool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  const objects = new MemoryObjects();
  const proof = { value: null as Proof | null };
  const nativeQueries: string[] = [], retirements: unknown[] = [];
  const { custody } = makeCustody(pool, objects, proof, nativeQueries, retirements);
  const erasureStore = new PostgresReceiptCustodyStore(pool);
  const fixture = await commandFixture(objects);
  const counters = { dispatches: 0 };
  let releaseDispatch!: () => void, signalDispatch!: () => void;
  const dispatchGate = new Promise<void>(resolveGate => { releaseDispatch = resolveGate; });
  const dispatchStarted = new Promise<void>(resolveStarted => { signalDispatch = resolveStarted; });
  let erasureClient: PoolClient | undefined;
  let commit: Promise<CommandResult> | undefined, erase: Promise<void> | undefined;
  try {
    await migrateAccess(pool);
    commit = custody.commit({ ...fixture.input, dispatch: committed(proof, counters, dispatchGate, signalDispatch) });
    await within(dispatchStarted, 5_000, 'owner command dispatch start');
    const payloadSha256 = (await pool.query<{ payload_sha256: string }>(
      'SELECT payload_sha256 FROM access.command_custody WHERE receipt=$1', [fixture.receipt])).rows[0]?.payload_sha256;
    if (!payloadSha256) throw new Error('prepared command was not persisted before graph dispatch');
    const erasure: CustodyPayloadErasure = { revision: fixture.revision, payloadSha256,
      erasureId: randomUUID(), erasureEpoch: '13' };
    erasureClient = await pool.connect();
    const eraserPid = (await erasureClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    let eraseFinished = false;
    erase = erasureStore.withReceipt(fixture.receipt, async session => {
      if (!session.clearPayloadForErasure) throw new Error('PostgreSQL custody erase capability is unavailable');
      await session.clearPayloadForErasure(erasure);
    }, erasureClient).then(() => { eraseFinished = true; });
    expect(await waitUntilBlocked(observer, eraserPid)).toBe(true);
    expect(eraseFinished).toBe(false);

    releaseDispatch();
    const result = await within(commit, 5_000, 'owner command settlement');
    await within(erase, 5_000, 'post-commit payload clear');
    expect(result.status).toBe('committed');
    expect(counters.dispatches).toBe(1);
    const row = (await pool.query<{ terminal: Record<string, unknown>; payload: Buffer | null;
      payload_erasure_id: string | null }>(`SELECT terminal,payload,payload_erasure_id
      FROM access.command_custody WHERE receipt=$1`, [fixture.receipt])).rows[0]!;
    expect(row.terminal).toMatchObject({ receipt: fixture.receipt, revision: fixture.revision,
      requestDigest: fixture.digest, sequence: '17', streamSequence: '4' });
    expect(row.payload).toBeNull();
    expect(row.payload_erasure_id).toBe(erasure.erasureId);
    expect(await custody.commit({ ...fixture.input, dispatch: async () => {
      counters.dispatches++;
      throw new Error('erased command custody must never dispatch');
    } })).toEqual(result);
    expect(counters.dispatches).toBe(1);
  } finally {
    releaseDispatch();
    await Promise.allSettled([...(commit ? [commit] : []), ...(erase ? [erase] : [])]);
    erasureClient?.release();
    await Promise.all([pool.end(), observer.end()]);
    cluster.remove();
  }
}, 60_000);
