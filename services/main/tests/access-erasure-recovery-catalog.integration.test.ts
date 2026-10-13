// sql-relations-allow: access.unclassified_recovery_probe -- A deliberate catalog omission must fail enumeration and retain authority comparison.
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { RankingGenerations } from '../src/modules/recommendation/ranking.ts';
import { prepareAccessErasureRecoveryFixture } from '../src/modules/access/fixture-erasure-recovery.ts';
import { sealRecoveryPayload, openRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { cloneQaOwnerDatabases } from '../../../tests/qa/support/databases.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../src/modules/access/admission.ts';
import { importAccessErasureRecoveryAttachment, type AccessErasureRecoveryExpectation } from '../src/modules/access/erasure-recovery.ts';
import { ACCESS_RECOVERY_CLASSIFICATION, accessRecoveryRule, assertAccessRecoveryClassification,
  scanAccessTables, scanAccessOutbox, accessStateTables, accessStateCoverage, resetAccessRecoveryState } from '../src/modules/work/access-recovery-coverage.ts';
import { captureReleaseBasis, proveReleaseTransition } from '../src/modules/owner/restore-release-binding.ts';
import type { RecoveryCoverage } from '../src/modules/work/restore-lineage.ts';
import { ownerCatalog, foldRowCoverage, scanOwnerTable, canonicalRowText } from '../src/modules/work/pg-recovery-frontier.ts';

const generationRule = ACCESS_RECOVERY_CLASSIFICATION['access.derived_generation']!;
const generation = { name: 'access.derived_generation' };

test('Access recovery enumerates the migrated catalog and refuses an unknown table or mixed column', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through goalctl test with the migrated owner fixture');
  const owners = await cloneQaOwnerDatabases(runId, ['access'], 'owner');
  const pool = new Pool({ connectionString: owners.urls.access, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const catalog = await ownerCatalog(client);
      const access = catalog.tables.filter(entry => entry.schema === 'access');
      expect(access.length).toBeGreaterThan(300);
      expect(() => assertAccessRecoveryClassification(catalog)).not.toThrow();
      for (const entry of access) expect(accessRecoveryRule(entry).class)
        .toBeOneOf(['authority', 'derived-projection', 'operational']);
      const mixed = access.find(entry => entry.name === generation.name)!;
      expect(mixed.columns.map(column => column.split(' ')[0]).sort())
        .toEqual(Object.keys(generationRule.columns!).sort());

      await client.query('SAVEPOINT table_class');
      await client.query('CREATE TABLE access.unclassified_recovery_probe (id uuid PRIMARY KEY)');
      const unknownTable = await ownerCatalog(client);
      expect(() => assertAccessRecoveryClassification(unknownTable)).toThrow('Access recovery table is unclassified');
      expect(accessRecoveryRule(unknownTable.tables.find(entry => entry.table === 'unclassified_recovery_probe')!).class)
        .toBe('authority');
      await client.query('ROLLBACK TO SAVEPOINT table_class');

      await client.query('ALTER TABLE access.derived_generation ADD COLUMN unclassified_build_state text');
      const unknownColumn = await ownerCatalog(client);
      expect(() => assertAccessRecoveryClassification(unknownColumn)).toThrow('Access recovery column is unclassified');
    } finally { await client.query('ROLLBACK'); client.release(); }
  } finally { await pool.end(); await owners.close(); }
}, 120_000);

test('restored ranking owner resumes the retained source stream before becoming ready', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through goalctl test with the migrated owner fixture');
  const owners = await cloneQaOwnerDatabases(runId, ['access'], 'owner');
  const pool = new Pool({ connectionString: owners.urls.access, max: 1 });
  const sourceEpoch = randomUUID(), restoredEpoch = randomUUID(), generationId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  try {
    await prepareAccessErasureRecoveryFixture(pool, { principalId: randomUUID(),
      actor: `https://rezics.com/id/${randomUUID()}`, resource: `https://rezics.com/id/${randomUUID()}`,
      scope: `https://rezics.com/id/${randomUUID()}`, generationId, dataEpoch: sourceEpoch,
      rateKey: 'c'.repeat(64), suffix });
    const fence = await engageAccessRecoveryFence(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await resetAccessRecoveryState(client, { derivedGeneration: '3', discoveryRefresh: '0' }, restoredEpoch);
      await releaseAccessRecoveryFence(client, fence);
      const borrowed = { query: (sql: string, params?: unknown[]) => client.query(sql, params), connect: async () => ({
        query: (sql: string, params?: unknown[]) => client.query(
          sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK' ? 'SELECT 1' : sql, params),
        release: () => {},
      }) } as unknown as Pool;
      const sourceQueries: string[] = [];
      const relay = { query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM relay.delivered_batch')) {
          expect(params[1]).toBe(sourceEpoch);
          sourceQueries.push(sql);
          return { rows: sql.includes('max(sequence)') ? [{ sequence: '7' }]
            : Array.from({ length: 7 }, (_, index) => ({ sequence: String(index + 1), event_count: 0 })) };
        }
        if (sql.includes('FROM relay.delivered_event')) return { rows: [] };
        throw new Error(`Unexpected retained stream query: ${sql}`);
      } } as unknown as Pool;
      const owner = new RankingGenerations({ access: borrowed, relay, dataEpoch: restoredEpoch,
        cursorKey: new Uint8Array(32), canReadWork: async () => true, leaseMs: 30_000 });
      const lease = await owner.claim(generationId);
      expect(lease).toBe('5');
      expect(await owner.runBatch(generationId, lease)).toMatchObject({ relayBatches: 7, checkpoint: '7', snapshotComplete: true });
      expect(await owner.finish(generationId, lease)).toMatchObject({ state: 'ready',
        checkpoint: { dataEpoch: sourceEpoch, sequence: '7', snapshotComplete: true } });
      expect(sourceQueries.length).toBeGreaterThanOrEqual(3);
    } finally { await client.query('ROLLBACK'); client.release(); }
  } finally { await pool.end(); await owners.close(); }
}, 120_000);

test('legacy signed Access coverage and version-1 native attachments keep their original digest rule', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through goalctl test with the migrated owner fixture');
  const owners = await cloneQaOwnerDatabases(runId, ['access'], 'owner');
  const pool = new Pool({ connectionString: owners.urls.access, max: 1 });
  try {
    await prepareAccessErasureRecoveryFixture(pool, { principalId: randomUUID(), actor: `https://rezics.com/id/${randomUUID()}`,
      resource: `https://rezics.com/id/${randomUUID()}`, scope: `https://rezics.com/id/${randomUUID()}`,
      generationId: randomUUID(), dataEpoch: randomUUID(), rateKey: 'd'.repeat(64), suffix: randomUUID().slice(0, 8) });
    const generation = await engageAccessRecoveryFence(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await canonicalRowText(client);
      const legacyCatalog = await ownerCatalog(client, {
        'access.outbox': 'digested separately by the Access outbox coverage',
        'access.recovery_fence': 'recovery control row; capture and release check it directly',
      });
      const tables: Record<string, { count: string; digest: string }> = {};
      for (const table of legacyCatalog.tables) tables[table.name] = await scanOwnerTable(client, table);
      const legacyState = foldRowCoverage('access-state-v5', legacyCatalog, tables);
      const key = 'ab'.repeat(32);
      const signed = sealRecoveryPayload({ accessStateCount: legacyState.count,
        accessStateDigest: legacyState.digest }, key, 'graph-recovery');
      const verified = openRecoveryPayload<{ accessStateCount: string; accessStateDigest: string;
        accessStateProfile?: 'access-state-v5' }>(JSON.stringify(signed), key, 'graph-recovery');
      expect((await scanAccessTables(client, verified.accessStateProfile ?? 'access-state-v5')).state)
        .toEqual({ count: verified.accessStateCount, digest: verified.accessStateDigest });
      const catalog = await ownerCatalog(client);
      const outbox = await scanAccessOutbox(client);
      const header = { kind: 'header', profile: 'rezics-access-erasure-recovery-v1' as const,
        version: 1 as const, catalogDigest: catalog.digest, baseFenceGeneration: generation,
        sourceFenceGeneration: generation, baseState: legacyState, sourceState: legacyState,
        baseOutbox: outbox, sourceOutbox: outbox };
      const footer = { kind: 'end', profile: header.profile, version: header.version,
        rowCount: '0', rowDigest: createHash('sha256').digest('hex') };
      const input = `${JSON.stringify(header)}\n${JSON.stringify(footer)}\n`;
      const expected: AccessErasureRecoveryExpectation = { ...header, ...footer,
        plaintextBytes: String(Buffer.byteLength(input)), plaintextDigest: createHash('sha256').update(input).digest('hex') };
      async function* bytes() { yield input; }
      expect(await importAccessErasureRecoveryAttachment(client, bytes(), expected))
        .toEqual({ imported: '0', alreadyPresent: '0' });
      expect((await scanAccessTables(client, 'access-state-v5')).state).toEqual(legacyState);
    } finally { await client.query('ROLLBACK'); client.release(); }
  } finally { await pool.end(); await owners.close(); }
}, 120_000);

test('release coverage wrappers and the derived post-state use the signed profile discriminator', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through goalctl test with the migrated owner fixture');
  const owners = await cloneQaOwnerDatabases(runId, ['access'], 'owner');
  const pool = new Pool({ connectionString: owners.urls.access, max: 1 });
  try {
    await prepareAccessErasureRecoveryFixture(pool, { principalId: randomUUID(), actor: `https://rezics.com/id/${randomUUID()}`,
      resource: `https://rezics.com/id/${randomUUID()}`, scope: `https://rezics.com/id/${randomUUID()}`,
      generationId: randomUUID(), dataEpoch: randomUUID(), rateKey: 'e'.repeat(64), suffix: randomUUID().slice(0, 8) });
    const client = await pool.connect();
    try {
      for (const discriminator of [undefined, 'access-state-v5', 'access-authority-v6'] as const) {
        const borrowed = { query: (sql: string, params?: unknown[]) => client.query(sql, params) } as unknown as Pool;
        const generation = await engageAccessRecoveryFence(borrowed);
        await client.query('BEGIN');
        const profile = discriminator ?? 'access-state-v5';
        const tables = await scanAccessTables(client, profile);
        const outbox = await scanAccessOutbox(client);
        const signed = sealRecoveryPayload({ accessStateProfile: discriminator,
          accessStateCount: tables.state.count, accessStateDigest: tables.state.digest,
          accessOutboxCount: outbox.count, accessOutboxDigest: outbox.digest }, 'ab'.repeat(32), 'graph-recovery');
        const coverage = openRecoveryPayload<RecoveryCoverage>(JSON.stringify(signed), 'ab'.repeat(32), 'graph-recovery');
        expect((await accessStateTables(pool, client, profile)).state).toEqual(tables.state);
        expect(await accessStateCoverage(pool, client, profile)).toEqual(tables.state);
        const reset = { dataEpoch: randomUUID(), floors: { derivedGeneration: '0', discoveryRefresh: '0' } };
        const basis = await captureReleaseBasis(pool, client, coverage, reset);
        await resetAccessRecoveryState(client, reset.floors, reset.dataEpoch);
        await releaseAccessRecoveryFence(client, generation);
        const transition = await proveReleaseTransition(pool, client, basis, generation);
        expect(transition.pre.state).toEqual(tables.state);
        expect(transition.post.state).toEqual((await scanAccessTables(client, profile)).state);
        await client.query('ROLLBACK');
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  } finally { await pool.end(); await owners.close(); }
}, 120_000);
