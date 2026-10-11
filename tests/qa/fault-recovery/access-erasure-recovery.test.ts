import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { expect, test } from 'bun:test';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { ERASURE_JOURNAL_EPOCH } from '../../../services/main/src/modules/erasure/journal.ts';
import { contentErasureDigest, erasureReceiptIri } from
  '../../../services/main/src/modules/erasure/request.ts';
import { exportJournalBoundAccessErasureRecoveryAttachment } from
  '../../../services/main/src/modules/work/restore-lineage.ts';
import { scanAccessOutbox, scanAccessTables, accessOutboxCoverage, accessStateTables } from
  '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { ACCESS_ERASURE_RECOVERY_PAGE, AccessErasureRecoveryConflict,
  exportAccessErasureRecoveryAttachment, importAccessErasureRecoveryAttachment,
  type AccessErasureRecoveryExpectation, type AccessErasureRecoveryRow,
  type AccessErasureRecoverySummary } from '../../../services/main/src/modules/access/erasure-recovery.ts';

const OUTBOX_KINDS = ['admission.registered', 'admission.claimed', 'admission.sealed'];

function pool(url: string, active: Set<Pool>): Pool {
  const value = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 2_000 });
  active.add(value);
  return value;
}

async function close(value: Pool, active: Set<Pool>): Promise<void> {
  await value.end();
  active.delete(value);
}

async function* chunks(bytes: Uint8Array, size = 4096): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) yield bytes.slice(offset, offset + size);
}

function attachmentRecords(bytes: Uint8Array): Array<Record<string, unknown>> {
  return Buffer.from(bytes).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

function resign(records: readonly Record<string, unknown>[], summary: AccessErasureRecoverySummary): {
  bytes: Buffer; expected: AccessErasureRecoveryExpectation;
} {
  const header = records[0]!;
  const rows = records.slice(1).filter(record => record.kind === 'row');
  const lines = rows.map(row => JSON.stringify(row));
  const rowHash = createHash('sha256');
  for (const line of lines) rowHash.update(line).update('\n');
  const footer = { kind: 'end', profile: summary.profile, version: summary.version,
    rowCount: String(rows.length), rowDigest: rowHash.digest('hex') };
  const plaintext = `${[JSON.stringify(header), ...lines, JSON.stringify(footer)].join('\n')}\n`;
  const bytes = Buffer.from(plaintext, 'utf8');
  return { bytes, expected: { ...summary, rowCount: String(rows.length), rowDigest: footer.rowDigest,
    plaintextBytes: String(bytes.byteLength), plaintextDigest: createHash('sha256').update(bytes).digest('hex') } };
}

async function exportInSnapshots(base: PoolClient, source: PoolClient): Promise<{
  bytes: Buffer; summary: AccessErasureRecoverySummary;
}> {
  const chunksOut: Uint8Array[] = [];
  const summary = await exportAccessErasureRecoveryAttachment(base, source,
    async chunk => { chunksOut.push(Buffer.from(chunk)); });
  return { bytes: Buffer.concat(chunksOut), summary };
}

async function beginSnapshot(client: PoolClient, readOnly = true): Promise<void> {
  await client.query(`BEGIN ISOLATION LEVEL REPEATABLE READ ${readOnly ? 'READ ONLY' : 'READ WRITE'}`);
}

test('OPS: native Access recovery replays exact erasure admissions, receipts, outboxes and fence invalidations', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated fault/recovery QA tier');
  const owners = await cloneQaOwnerDatabases(runId, ['access', 'relay'], 'owner');
  const pools = new Set<Pool>();
  let source = pool(owners.urls.access, pools);
  const relay = pool(owners.urls.relay, pools);
  let base: Pool | undefined;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const principalId = randomUUID();
  const resource = `https://rezics.com/id/${randomUUID()}`;
  const scope = `erasure:${resource}`;
  const probeId = randomUUID();

  try {
    await source.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, `https://qa-${suffix}.local`, `erasure-${suffix}`]);
    await source.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    await source.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await source.query(`CREATE TABLE access.erasure_recovery_probe_${suffix} (
      id uuid PRIMARY KEY, body text NOT NULL)`);
    await source.query(`INSERT INTO access.erasure_recovery_probe_${suffix} (id, body) VALUES ($1, 'base')`, [probeId]);
    const baseFenceGeneration = await engageAccessRecoveryFence(source);
    const baseUrl = await owners.snapshot('access', async () => close(source, pools));
    source = pool(owners.urls.access, pools);
    base = pool(baseUrl, pools);

    await releaseAccessRecoveryFence(source, baseFenceGeneration);
    const revisionIds = Array.from({ length: ACCESS_ERASURE_RECOVERY_PAGE + 1 }, () => randomUUID());
    const admissionIds = Array.from({ length: revisionIds.length }, () => randomUUID());
    const idempotencyKeys = Array.from({ length: revisionIds.length }, () => randomUUID());
    const requestDigests = revisionIds.map(revisionId => contentErasureDigest({ actingSubject: actor,
      resourceId: resource, revisionIds: [revisionId] }));
    const receipts = admissionIds.map(erasureReceiptIri);
    const baseJournalEpoch = (await relay.query<{ epoch: string | null }>(
      'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure')).rows[0]!.epoch;
    const sequences = admissionIds.map((_, index) => String(BigInt(baseJournalEpoch ?? '0') + BigInt(index + 1)));
    await source.query(`INSERT INTO access.admission
        (id, principal_id, acting_subject, scope_id, action, idempotency_key, request_digest,
         authority_epoch, expires_at, state, claimed_at, graph_receipt, graph_outcome,
         graph_data_epoch, graph_sequence, sealed_at)
      SELECT item.id, $1, $2, $3, 'erasure.request', item.idempotency_key, item.request_digest,
        0, clock_timestamp() + interval '1 hour', 'sealed', clock_timestamp(), item.graph_receipt,
        'succeeded', $4, item.graph_sequence, clock_timestamp()
      FROM unnest($5::uuid[], $6::text[], $7::text[], $8::text[], $9::text[])
        AS item(id, idempotency_key, request_digest, graph_receipt, graph_sequence)`,
    [principalId, actor, scope, ERASURE_JOURNAL_EPOCH, admissionIds, idempotencyKeys, requestDigests, receipts, sequences]);
    await source.query(`INSERT INTO access.admission_receipt
        (admission_id, principal_id, action, idempotency_key, request_digest, outcome)
      SELECT item.id, $1, 'erasure.request', item.idempotency_key, item.request_digest, 'registered'
      FROM unnest($2::uuid[], $3::text[], $4::text[]) AS item(id, idempotency_key, request_digest)`,
    [principalId, admissionIds, idempotencyKeys, requestDigests]);
    const outboxIds = Array.from({ length: admissionIds.length * OUTBOX_KINDS.length }, () => randomUUID());
    const outboxAdmissions = admissionIds.flatMap(id => OUTBOX_KINDS.map(() => id));
    const outboxKinds = admissionIds.flatMap(() => OUTBOX_KINDS);
    await source.query(`INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
      SELECT item.id, item.kind, item.admission_id, $1, 0
      FROM unnest($2::uuid[], $3::text[], $4::uuid[])
        AS item(id, kind, admission_id)`, [scope, outboxIds, outboxKinds, outboxAdmissions]);
    const currentFenceGeneration = await engageAccessRecoveryFence(source);
    expect(BigInt(currentFenceGeneration)).toBe(BigInt(baseFenceGeneration) + 2n);

    const baseClient = await base.connect();
    const sourceClient = await source.connect();
    let captured: Awaited<ReturnType<typeof exportInSnapshots>>;
    try {
      await beginSnapshot(baseClient);
      await beginSnapshot(sourceClient);
      captured = await exportInSnapshots(baseClient, sourceClient);
    } finally {
      await baseClient.query('ROLLBACK');
      await sourceClient.query('ROLLBACK');
      baseClient.release();
      sourceClient.release();
    }
    expect(captured.summary.rowCount).toBe(String(admissionIds.length * 5 + 4));
    expect(captured.summary.baseFenceGeneration).toBe(baseFenceGeneration);
    expect(captured.summary.sourceFenceGeneration).toBe(currentFenceGeneration);
    const rows = attachmentRecords(captured.bytes).slice(1, -1) as unknown as AccessErasureRecoveryRow[];
    expect(rows.filter(row => row.table === 'access.admission')).toHaveLength(ACCESS_ERASURE_RECOVERY_PAGE + 1);
    expect(rows.filter(row => row.table === 'access.admission_receipt')).toHaveLength(ACCESS_ERASURE_RECOVERY_PAGE + 1);
    expect(rows.filter(row => row.table === 'access.outbox')).toHaveLength((ACCESS_ERASURE_RECOVERY_PAGE + 1) * 3);
    expect(rows.filter(row => row.table === 'access.discovery_source_change')).toHaveLength(2);
    expect(rows.filter(row => row.table === 'access.also_enjoyed_source_change')).toHaveLength(2);
    expect((rows.find(row => row.table === 'access.admission')!.values.authority_witness as object))
      .toEqual({ $rezicsNativeJson: 'sql-null' });

    const readBase = await base.connect(), readSource = await source.connect(), journal = await relay.connect();
    try {
      await beginSnapshot(readBase);
      await beginSnapshot(readSource);
      await journal.query('BEGIN');
      const baseEpoch = (await journal.query<{ epoch: string | null }>(
        'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure')).rows[0]!.epoch;
      expect(baseEpoch).toBe(baseJournalEpoch);
      const erasureIds = admissionIds.map(() => randomUUID());
      const insertJournal = async (from: number, through: number) => {
        await journal.query(`INSERT INTO relay.erasure
          (id, erasure_epoch, operation_id, request_digest, kind, authority, principal_id,
           admission_id, authority_epoch, stage, suppression_status, suppressed_at)
          SELECT item.id, item.epoch, 'erasure:' || item.admission_id, item.digest,
            'revision', 'access_admission', $1, item.admission_id, 0, 'fenced', 'suppressed', clock_timestamp()
          FROM unnest($2::uuid[], $3::bigint[], $4::uuid[], $5::text[])
            AS item(id, epoch, admission_id, digest)`,
        [principalId, erasureIds.slice(from, through), sequences.slice(from, through),
          admissionIds.slice(from, through), requestDigests.slice(from, through)]);
        await journal.query(`INSERT INTO relay.erasure_target (erasure_id, ordinal, owner, target_kind, target_ref)
          SELECT item.id, 1, 'content', 'content_revision', item.revision
          FROM unnest($1::uuid[], $2::text[]) AS item(id, revision)`,
        [erasureIds.slice(from, through), revisionIds.slice(from, through)]);
      };
      const exportBoundJournal = (sourceEpoch: string) =>
        exportJournalBoundAccessErasureRecoveryAttachment(readBase, readSource, journal,
          baseEpoch, sourceEpoch, async () => {});
      await insertJournal(0, admissionIds.length - 1);
      await expect(exportBoundJournal(sequences[sequences.length - 2]!))
        .rejects.toThrow('native admissions and current erasure journal delta differ');
      await insertJournal(admissionIds.length - 1, admissionIds.length);

      let peakRetainedCollection = 0;
      const add = Set.prototype.add, set = Map.prototype.set;
      Set.prototype.add = function<T>(this: Set<T>, value: T): Set<T> {
        const result = add.call(this, value) as Set<T>;
        peakRetainedCollection = Math.max(peakRetainedCollection, this.size);
        return result;
      };
      Map.prototype.set = function<K, V>(this: Map<K, V>, key: K, value: V): Map<K, V> {
        const result = set.call(this, key, value) as Map<K, V>;
        peakRetainedCollection = Math.max(peakRetainedCollection, this.size);
        return result;
      };
      try {
        const exact = await exportBoundJournal(sequences[sequences.length - 1]!);
        expect(exact).toEqual(captured.summary);
        // Encryption runs a second export: its closure must start from the first ID again.
        expect(await exportBoundJournal(sequences[sequences.length - 1]!)).toEqual(exact);
      } finally {
        Set.prototype.add = add;
        Map.prototype.set = set;
      }
      expect(peakRetainedCollection).toBe(ACCESS_ERASURE_RECOVERY_PAGE);

      const extraAdmission = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      await journal.query(`INSERT INTO relay.erasure
        (id, erasure_epoch, operation_id, request_digest, kind, authority, principal_id,
         admission_id, authority_epoch, stage, suppression_status, suppressed_at)
        VALUES ($1, $2, $3, $4, 'revision', 'access_admission', $5, $6, 0,
          'fenced', 'suppressed', clock_timestamp())`,
      [randomUUID(), String(BigInt(sequences[sequences.length - 1]!) + 1n), `erasure:${extraAdmission}`,
        requestDigests[0], principalId, extraAdmission]);
      await expect(exportBoundJournal(String(BigInt(sequences[sequences.length - 1]!) + 1n)))
        .rejects.toThrow('native admissions and current erasure journal delta differ');
    } finally {
      await readBase.query('ROLLBACK');
      await readSource.query('ROLLBACK');
      await journal.query('ROLLBACK');
      readBase.release(); readSource.release(); journal.release();
    }

    const sourceState = await accessStateTables(source);
    const sourceOutbox = await accessOutboxCoverage(source);
    const baseState = await accessStateTables(base);
    const baseOutbox = await accessOutboxCoverage(base);
    expect(captured.summary.sourceState).toEqual(sourceState.state);
    expect(captured.summary.sourceOutbox).toEqual(sourceOutbox);
    expect(captured.summary.baseState).toEqual(baseState.state);
    expect(captured.summary.baseOutbox).toEqual(baseOutbox);

    const rejectImport = async (bytes: Uint8Array, expected: AccessErasureRecoveryExpectation, reason: string) => {
      const client = await base!.connect();
      try {
        await client.query('BEGIN READ WRITE');
        await expect(importAccessErasureRecoveryAttachment(client, chunks(bytes), expected))
          .rejects.toThrow(reason);
        expect(await scanAccessTables(client)).toEqual(baseState);
        expect(await scanAccessOutbox(client)).toEqual(baseOutbox);
      } finally {
        try { await client.query('ROLLBACK'); } finally { client.release(); }
      }
    };

    const signedRows = attachmentRecords(captured.bytes);
    const missingReceipt = signedRows.filter(row => !(row.kind === 'row'
      && row.table === 'access.admission_receipt' && row.key
      && (row.key as Record<string, string>).admission_id === admissionIds[0]));
    const missing = resign(missingReceipt, captured.summary);
    await rejectImport(missing.bytes, missing.expected,
      'new Access erasure admission is missing its native registration receipt');

    const withMissingTimestamp = signedRows.map(record => {
      if (record.kind !== 'row' || record.table !== 'access.admission'
        || (record.key as Record<string, string>).id !== admissionIds[0]) return record;
      const row = record as unknown as AccessErasureRecoveryRow;
      return { ...record, values: { ...row.values, sealed_at: null } };
    });
    const missingTimestamp = resign(withMissingTimestamp, captured.summary);
    await rejectImport(missingTimestamp.bytes, missingTimestamp.expected, 'missing sealed_at');

    const duplicateRow = signedRows[1]!;
    const duplicated = resign([signedRows[0]!, duplicateRow, duplicateRow, ...signedRows.slice(2)], captured.summary);
    await rejectImport(duplicated.bytes, duplicated.expected, 'native Access attachment keys are duplicated or out of order');

    const unknownTableRows = signedRows.map(record => record.kind === 'row'
      ? { ...record, table: 'access.erasure_recovery_unknown' } : record);
    const unknownTable = resign(unknownTableRows, captured.summary);
    await rejectImport(unknownTable.bytes, unknownTable.expected, 'unknown native Access attachment schema or row');

    const alteredOutbox = signedRows.map(record => {
      if (record.kind !== 'row' || record.table !== 'access.outbox') return record;
      const row = record as unknown as AccessErasureRecoveryRow;
      return { ...record, values: { ...row.values, created_at: '2000-01-01 00:00:00+00' } };
    });
    const tampered = Buffer.from(`${alteredOutbox.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    await rejectImport(tampered, captured.summary, 'native Access attachment digest or row count differs');

    const importClient = await base.connect();
    try {
      await importClient.query('BEGIN READ WRITE');
      const imported = await importAccessErasureRecoveryAttachment(importClient, chunks(captured.bytes), captured.summary);
      expect(imported).toEqual({ imported: captured.summary.rowCount, alreadyPresent: '0' });
      expect(await scanAccessTables(importClient)).toEqual(sourceState);
      expect(await scanAccessOutbox(importClient)).toEqual(sourceOutbox);
    } finally {
      try { await importClient.query('ROLLBACK'); } catch { /* preserve successful import assertion */ }
      importClient.release();
    }

    for (const { mutation, refusal } of [
      { mutation: `UPDATE access.erasure_recovery_probe_${suffix} SET body = 'changed' WHERE id = '${probeId}'`,
        refusal: `base Access row changed: access.erasure_recovery_probe_${suffix}` },
      { mutation: `DELETE FROM access.erasure_recovery_probe_${suffix} WHERE id = '${probeId}'`,
        refusal: `base Access row was removed: access.erasure_recovery_probe_${suffix}` },
    ]) {
      const readBase = await base.connect(), changedSource = await source.connect();
      try {
        await beginSnapshot(readBase);
        await changedSource.query('BEGIN');
        await changedSource.query(mutation);
        let error: unknown;
        try { await exportInSnapshots(readBase, changedSource); }
        catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(AccessErasureRecoveryConflict);
        expect((error as Error).message).toBe(refusal);
      } finally {
        try { await readBase.query('ROLLBACK'); } catch { /* connection cleanup */ }
        try { await changedSource.query('ROLLBACK'); } catch { /* connection cleanup */ }
        readBase.release();
        changedSource.release();
      }
    }

    const unknownSchema = await source.connect();
    try {
      await beginSnapshot(unknownSchema, false);
      await unknownSchema.query(`CREATE TABLE access.erasure_recovery_schema_${suffix} (id uuid PRIMARY KEY)`);
      const readBase = await base.connect();
      try {
        await beginSnapshot(readBase);
        await expect(exportInSnapshots(readBase, unknownSchema)).rejects.toBeInstanceOf(AccessErasureRecoveryConflict);
      } finally { await readBase.query('ROLLBACK'); readBase.release(); }
    } finally { await unknownSchema.query('ROLLBACK'); unknownSchema.release(); }
  } finally {
    await Promise.allSettled([...pools].map(value => value.end()));
    await owners.close();
  }
}, 600_000);
