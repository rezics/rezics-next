import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { AdmissionUnavailable, engageAccessRecoveryFence, releaseAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { assertRetainedAuthorityCoverage, ErasureAuthorityCoverageConflict } from
  '../../../services/main/src/modules/erasure/authority.ts';
import { relayTransaction } from '../../../services/main/src/modules/erasure/journal.ts';
import { assertAccountDeletionJournalCoverage } from
  '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { retainRecoveryCoverageHead } from
  '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { withPreservationFence, type PreservationFence } from
  '../../../services/main/src/modules/public-report/preservation.ts';
import { accessOutboxCoverage, accessStateCoverage } from
  '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let access: Pool, relay: Pool, accessObserver: Client, relayObserver: Client;

beforeAll(async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated QA integration tier');
  databases = await cloneQaOwnerDatabases(runId, ['access', 'relay']);
  access = new Pool({ connectionString: databases.urls.access, max: 1, connectionTimeoutMillis: 1500 });
  relay = new Pool({ connectionString: databases.urls.relay, max: 1, connectionTimeoutMillis: 1500 });
  accessObserver = new Client({ connectionString: databases.urls.access });
  relayObserver = new Client({ connectionString: databases.urls.relay });
  await accessObserver.connect();
  await relayObserver.connect();
}, 30_000);

afterAll(async () => {
  await Promise.allSettled([access?.end(), relay?.end(), accessObserver?.end(), relayObserver?.end()]);
  await databases?.close();
}, 30_000);

async function transactionIdentity(client: PoolClient) {
  return (await client.query<{ pid: number; transaction: string }>(
    'SELECT pg_backend_pid() AS pid, txid_current()::text AS transaction')).rows[0]!;
}

async function preservationLockAvailable(resource: string): Promise<boolean> {
  await accessObserver.query('BEGIN');
  try {
    return (await accessObserver.query<{ available: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 931)) AS available', [resource])).rows[0]!.available;
  } finally { await accessObserver.query('ROLLBACK'); }
}

async function seedHold(resource: string): Promise<string> {
  const caseId = randomUUID(), holdId = randomUUID();
  await access.query(`INSERT INTO access.governance_case
    (id, kind, authority_kind, authority_scope_id, context, target_owner,
      target_resource, target_component, disclosure)
    VALUES ($1, 'content_report', 'platform', 'governance:platform',
      'urn:rezics:context:global', 'content', $2, 'body', 'private')`, [caseId, resource]);
  await access.query(`INSERT INTO access.governance_preservation_hold
    (id, case_id, target_resource, reason) VALUES ($1, $2, $3, 'retained safety evidence')`,
  [holdId, caseId, resource]);
  return holdId;
}

test('borrowed preservation keeps the caller transaction and target lock after success and callback interruption', async () => {
  const client = await access.connect();
  const resource = `urn:rezics:borrowed-preservation:${randomUUID()}`;
  const principal = randomUUID();
  let escaped: PreservationFence | undefined;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '11s'");
    await client.query("SET LOCAL statement_timeout = '13s'");
    const identity = await transactionIdentity(client);
    await client.query('SAVEPOINT caller_owned');
    const result = await withPreservationFence(client, resource, 'borrowed-write', async fence => {
      escaped = fence;
      await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1::uuid, 'https://borrowed.test', $1::text)`, [principal]);
      await expect(withPreservationFence(fence, `${resource}:other`, 'wrong-target', async () => 'invalid'))
        .rejects.toThrow('Preservation fence is unavailable');
      return withPreservationFence(fence, resource, 'nested-write', async () => 'written');
    });
    expect(result).toEqual({ held: false, value: { held: false, value: 'written' } });
    expect(await transactionIdentity(client)).toEqual(identity);
    expect((await client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('11s');
    expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('13s');
    expect((await accessObserver.query('SELECT 1 FROM access.principal WHERE id = $1', [principal])).rowCount).toBe(0);
    expect(await preservationLockAvailable(resource)).toBe(false);
    await expect(withPreservationFence(escaped!, resource, 'escaped-write', async () => 'invalid'))
      .rejects.toThrow('Preservation fence is unavailable');
    await expect(withPreservationFence(client, resource, 'interrupted-write', async () => {
      throw new Error('caller interruption');
    })).rejects.toThrow('caller interruption');
    expect(await transactionIdentity(client)).toEqual(identity);
    expect(await preservationLockAvailable(resource)).toBe(false);
    await client.query('ROLLBACK TO SAVEPOINT caller_owned');
    expect((await client.query('SELECT 1 FROM access.principal WHERE id = $1', [principal])).rowCount).toBe(0);
    await client.query('ROLLBACK');
    expect(await preservationLockAvailable(resource)).toBe(true);
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect(await withPreservationFence(access, resource, 'standalone-write', async () => 'written'))
    .toEqual({ held: false, value: 'written' });
  await expect(withPreservationFence(access, resource, 'standalone-interruption', async () => {
    throw new Error('standalone interruption');
  })).rejects.toThrow('standalone interruption');
  expect(await preservationLockAvailable(resource)).toBe(true);
}, 15_000);

test('borrowed preservation postponement is caller-owned and standalone retry keeps one retained audit', async () => {
  const resource = `urn:rezics:borrowed-hold:${randomUUID()}`;
  const holdId = await seedHold(resource);
  const operationId = `held:${randomUUID()}`;
  const audit = 'SELECT 1 FROM access.governance_erasure_postponement WHERE hold_id = $1 AND operation_id = $2';
  const client = await access.connect();
  let writes = 0;
  try {
    await client.query('BEGIN');
    const identity = await transactionIdentity(client);
    await client.query('SAVEPOINT caller_owned');
    expect(await withPreservationFence(client, resource, operationId, async () => ++writes)).toEqual({ held: true });
    expect(writes).toBe(0);
    expect(await transactionIdentity(client)).toEqual(identity);
    expect((await client.query(audit, [holdId, operationId])).rowCount).toBe(1);
    expect((await accessObserver.query(audit, [holdId, operationId])).rowCount).toBe(0);
    expect(await preservationLockAvailable(resource)).toBe(false);
    await client.query('ROLLBACK TO SAVEPOINT caller_owned');
    expect((await client.query(audit, [holdId, operationId])).rowCount).toBe(0);
    await client.query('ROLLBACK');
  } finally { await client.query('ROLLBACK'); client.release(); }
  for (let retry = 0; retry < 2; retry++) {
    expect(await withPreservationFence(access, resource, operationId, async () => ++writes)).toEqual({ held: true });
  }
  expect(writes).toBe(0);
  expect((await accessObserver.query(audit, [holdId, operationId])).rowCount).toBe(1);
  expect(await preservationLockAvailable(resource)).toBe(true);
}, 15_000);

test('borrowed authority and Access release reuse max-one clients and retain the allocator lock until caller completion', async () => {
  const generation = await engageAccessRecoveryFence(access);
  const accessClient = await access.connect();
  let relayClient: PoolClient | undefined;
  const consumer = `borrowed:${randomUUID()}`;
  const principal = randomUUID();
  try {
    await accessClient.query('BEGIN');
    const accessIdentity = await transactionIdentity(accessClient);
    await accessClient.query('SAVEPOINT caller_owned');
    await accessClient.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1::uuid, 'https://borrowed.test', $1::text)`, [principal]);
    const outbox = await accessOutboxCoverage(access, accessClient);
    const state = await accessStateCoverage(access, accessClient);
    // Only Access and relay evidence is consumed by this authority check.
    const payload = { priorDataEpoch: randomUUID(), priorSequence: '0', relay: { consumer },
      accessOutboxCount: outbox.count, accessOutboxDigest: outbox.digest,
      accessStateCount: state.count, accessStateDigest: state.digest };
    const hmacKey = 'ad'.repeat(32);
    const authority = { sealedCoverage: JSON.stringify(sealRecoveryPayload(payload, hmacKey,
      'graph-recovery-coverage')), hmacKey };
    await relay.query(`INSERT INTO relay.checkpoint (consumer, data_epoch, sequence) VALUES ($1, $2, 0)`,
      [consumer, payload.priorDataEpoch]);
    await retainRecoveryCoverageHead(relay, authority.sealedCoverage, hmacKey);
    relayClient = await relay.connect();
    await relayClient.query('BEGIN');
    const relayIdentity = await transactionIdentity(relayClient);
    await relayClient.query('SAVEPOINT caller_owned');
    await relayTransaction(relay, async held => {
      expect(held).toBe(relayClient!);
      await held.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
      await assertAccountDeletionJournalCoverage(access, relay, accessClient, held);
      await assertRetainedAuthorityCoverage(held, access, consumer, authority, accessClient);
      await accessClient.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')",
        [`https://rezics.com/id/${randomUUID()}`]);
      await expect(assertRetainedAuthorityCoverage(held, access, consumer, authority, accessClient))
        .rejects.toBeInstanceOf(ErasureAuthorityCoverageConflict);
      await expect(releaseAccessRecoveryFence(accessClient, String(BigInt(generation) + 1n)))
        .rejects.toBeInstanceOf(AdmissionUnavailable);
      expect((await accessClient.query('SELECT open FROM access.recovery_fence WHERE id = true')).rows[0].open).toBe(false);
      await releaseAccessRecoveryFence(accessClient, generation);
    }, relayClient);
    expect(await transactionIdentity(accessClient)).toEqual(accessIdentity);
    expect(await transactionIdentity(relayClient)).toEqual(relayIdentity);
    expect((await accessObserver.query('SELECT open FROM access.recovery_fence WHERE id = true')).rows[0].open).toBe(false);
    expect((await accessObserver.query('SELECT 1 FROM access.principal WHERE id = $1', [principal])).rowCount).toBe(0);
    await relayObserver.query('BEGIN');
    try {
      expect((await relayObserver.query(`SELECT pg_try_advisory_xact_lock(
        hashtextextended('rezics-relay-erasure-epoch', 0)) AS available`)).rows[0].available).toBe(false);
    } finally { await relayObserver.query('ROLLBACK'); }
    await accessClient.query('ROLLBACK TO SAVEPOINT caller_owned');
    expect((await accessClient.query('SELECT open FROM access.recovery_fence WHERE id = true')).rows[0].open).toBe(false);
    await relayClient.query('ROLLBACK TO SAVEPOINT caller_owned');
    await relayObserver.query('BEGIN');
    try {
      expect((await relayObserver.query(`SELECT pg_try_advisory_xact_lock(
        hashtextextended('rezics-relay-erasure-epoch', 0)) AS available`)).rows[0].available).toBe(true);
    } finally { await relayObserver.query('ROLLBACK'); }
  } finally {
    await accessClient.query('ROLLBACK'); accessClient.release();
    if (relayClient) { await relayClient.query('ROLLBACK'); relayClient.release(); }
  }
  await releaseAccessRecoveryFence(access, generation);
  await expect(releaseAccessRecoveryFence(access, generation)).rejects.toBeInstanceOf(AdmissionUnavailable);
}, 20_000);

test('borrowed relay callback interruption preserves the caller savepoint and standalone transactions still commit or roll back', async () => {
  const client = await relay.connect();
  const consumer = `transaction:${randomUUID()}`;
  try {
    await client.query('BEGIN');
    const identity = await transactionIdentity(client);
    await client.query('SAVEPOINT caller_owned');
    await expect(relayTransaction(relay, async held => {
      await held.query(`INSERT INTO relay.checkpoint (consumer, data_epoch, sequence) VALUES ($1, $2, 0)`,
        [consumer, randomUUID()]);
      throw new Error('caller interruption');
    }, client)).rejects.toThrow('caller interruption');
    expect(await transactionIdentity(client)).toEqual(identity);
    expect((await client.query('SELECT 1 FROM relay.checkpoint WHERE consumer = $1', [consumer])).rowCount).toBe(1);
    expect((await relayObserver.query('SELECT 1 FROM relay.checkpoint WHERE consumer = $1', [consumer])).rowCount).toBe(0);
    await client.query('ROLLBACK TO SAVEPOINT caller_owned');
    expect((await client.query('SELECT 1 FROM relay.checkpoint WHERE consumer = $1', [consumer])).rowCount).toBe(0);
  } finally { await client.query('ROLLBACK'); client.release(); }
  await relayTransaction(relay, held => held.query(`INSERT INTO relay.checkpoint
    (consumer, data_epoch, sequence) VALUES ($1, $2, 0)`, [consumer, randomUUID()]));
  expect((await relayObserver.query('SELECT sequence::text FROM relay.checkpoint WHERE consumer = $1', [consumer])).rows)
    .toEqual([{ sequence: '0' }]);
  await expect(relayTransaction(relay, async held => {
    await held.query('UPDATE relay.checkpoint SET sequence = 1 WHERE consumer = $1', [consumer]);
    throw new Error('standalone interruption');
  })).rejects.toThrow('standalone interruption');
  expect((await relayObserver.query('SELECT sequence::text FROM relay.checkpoint WHERE consumer = $1', [consumer])).rows)
    .toEqual([{ sequence: '0' }]);
}, 15_000);
