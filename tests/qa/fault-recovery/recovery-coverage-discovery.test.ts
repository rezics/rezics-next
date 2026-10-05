import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { openRecoveryPayload, sealRecoveryPayload }
  from '../../../services/account/src/recovery-envelope.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';
import { accessOutboxCoverage, accessStateCoverage, accessStateTables }
  from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { assertContentRecoveryCoverage, captureContentRecoveryCoverage, ContentRecoveryConflict,
  graphContentReferences, type ContentRecoveryCoverage }
  from '../../../services/main/src/modules/work/content-recovery-coverage.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');
const manifestKey = 'e5'.repeat(32);
const emptyDigest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function stack(action: 'stack:up' | 'stack:reset', runId: string): void {
  const result = spawnSync('bun', ['scripts/dev/cli.ts', action, '--profile', 'qa', '--run-id', runId],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`${action}: ${(result.stderr || result.stdout || result.error?.message || '').slice(-2000)}`);
  }
}

test('OPS03: recovery coverage discovers a new owner schema table and owner-row IRI without code changes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the fault/recovery tier');
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const runId = `coverage-${nonce}`;
  const directory = join(root, '.temp', `recovery-coverage-${nonce}`);
  const pools: Pool[] = [];
  let started = false;
  try {
    started = true;
    stack('stack:up', runId);
    const apps = readEnv(join(stackDirectory(root, { profile: 'qa', runId }), 'apps.env'));
    const compose = readEnv(join(stackDirectory(root, { profile: 'qa', runId }), 'compose.env'));
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    pools.push(contentPool, accessPool);
    const accessMigrations = join(root, 'services/main/migrations/access');
    for (const file of schemaFiles(root, 'access')) {
      await accessPool.query(readFileSync(join(accessMigrations, file), 'utf8'));
    }
    await migrateContent(contentPool);
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const capture = async () => captureContentRecoveryCoverage(contentPool,
      await graphContentReferences(fuseki));

    // Every migrated Content schema is covered, keyed by its primary key.
    const baseline = await capture();
    expect(baseline.version).toBe(5);
    expect(Object.keys(baseline.tables)).toEqual(expect.arrayContaining(['content.revision',
      'content.schema_migration', 'pkg.npm_resolution', 'source.record', 'verification.origin']));
    expect(Object.keys(baseline.tables)).toEqual([...Object.keys(baseline.tables)].sort());
    expect(baseline.excluded).toEqual({});
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, baseline)).resolves.toBeUndefined();

    // A future domain migration adds a schema and table; coverage needs no code change.
    const schema = `probe_${nonce}`;
    await contentPool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.evidence_item (id uuid, body text NOT NULL,
        PRIMARY KEY (id) INCLUDE (body))`);
    const empty = await capture();
    expect(empty.tables[`${schema}.evidence_item`]).toEqual({ count: '0', digest: emptyDigest });
    expect(empty.catalogDigest).not.toBe(baseline.catalogDigest);
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, baseline))
      .rejects.toThrow('restored Content owner differs from captured cut');
    const item = randomUUID();
    await contentPool.query(`INSERT INTO ${schema}.evidence_item (id, body) VALUES ($1, 'exact')`, [item]);
    const filled = await capture();
    expect(filled.tables[`${schema}.evidence_item`]?.count).toBe('1');
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, empty))
      .rejects.toThrow('restored Content owner differs from captured cut');

    // A graph fact names the row by its owner-row IRI; release now requires that row.
    const graph = `urn:rezics:graph:coverage-probe-${nonce}`;
    const owned = `urn:rezics:${schema}:evidence-item:${item}`;
    await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH <${graph}> {
      <https://rezics.com/id/${randomUUID()}> rv:evidenceSetRevision <${owned}> ;
        rv:transientNode <urn:rezics:${schema}:scratch-node:1> } }`);
    const referenced = await capture();
    expect(referenced.graphReferencesCount).toBe(String(Number(filled.graphReferencesCount) + 1));
    expect((await graphContentReferences(fuseki)).map(reference => reference.object)).toContain(owned);
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, filled))
      .rejects.toThrow('restored graph Content references differ from captured cut');
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, referenced)).resolves.toBeUndefined();
    await contentPool.query(`DELETE FROM ${schema}.evidence_item WHERE id = $1`, [item]);
    await expect(capture()).rejects.toThrow(`graph owner reference is unavailable: ${schema}.evidence_item ${item}`);
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, referenced))
      .rejects.toBeInstanceOf(ContentRecoveryConflict);
    await contentPool.query(`INSERT INTO ${schema}.evidence_item (id, body) VALUES ($1, 'exact')`, [item]);
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, referenced)).resolves.toBeUndefined();

    // A table without a primary key fails closed until its migration declares it disposable.
    await contentPool.query(`CREATE TABLE ${schema}.scratch (note text)`);
    await expect(capture()).rejects.toThrow(`recovery coverage requires a primary key: ${schema}.scratch`);
    await contentPool.query(`COMMENT ON TABLE ${schema}.scratch IS 'recovery-coverage: exlude cache'`);
    await expect(capture()).rejects.toThrow(`recovery-coverage comment is malformed: ${schema}.scratch`);
    await contentPool.query(`COMMENT ON TABLE ${schema}.scratch IS
      E'Rebuildable probe notes.\\nrecovery-coverage: exclude rebuilt from evidence items'`);
    const disposable = await capture();
    expect(disposable.excluded).toEqual({ [`${schema}.scratch`]: 'rebuilt from evidence items' });
    await contentPool.query(`INSERT INTO ${schema}.scratch (note) VALUES ('disposable')`);
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, disposable)).resolves.toBeUndefined();
    await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH <${graph}> {
      <https://rezics.com/id/${randomUUID()}> rv:cites <urn:rezics:${schema}:scratch:1> } }`);
    await expect(capture()).rejects.toThrow('graph references excluded owner state');
    await fuseki.update(`DELETE WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);

    // The owner scan must resume at the actual primary key across its 128-row page boundary.
    await contentPool.query(`INSERT INTO ${schema}.evidence_item (id, body)
      SELECT ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'page'
      FROM generate_series(1, 128) AS generated(n)`);
    const paged = await capture();
    expect(paged.tables[`${schema}.evidence_item`]?.count).toBe('129');
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, paged)).resolves.toBeUndefined();

    // Retained version-4 evidence fails with a version error instead of a row mismatch.
    await expect(assertContentRecoveryCoverage(contentPool, fuseki,
      { ...disposable, version: 4 } as unknown as ContentRecoveryCoverage))
      .rejects.toThrow('Content recovery coverage version 4 is not version 5');

    // Access discovers its tables the same way; its outbox and fence keep dedicated checks.
    const accessBaseline = await accessStateTables(accessPool);
    expect(accessBaseline.state).toEqual(await accessStateCoverage(accessPool));
    expect(accessBaseline.excluded).toEqual({
      'access.outbox': 'digested separately by the Access outbox coverage',
      'access.recovery_fence': 'recovery control row; capture and release check it directly' });
    expect(Object.keys(accessBaseline.tables)).toEqual(expect.arrayContaining([
      'access.admission', 'access.group_change_receipt', 'access.group_impact_proposal',
      'access.group_impact_activation', 'access.search_read_lease']));
    const outboxBeforeFence = await accessOutboxCoverage(accessPool);
    // Engaging the fence appends one change row to each source change log; the
    // fence revisions move only when a projection build folds them.
    const sourceChanges = ['access.discovery_source_change', 'access.also_enjoyed_source_change'];
    await engageAccessRecoveryFence(accessPool);
    const afterFence = await accessStateTables(accessPool);
    for (const name of sourceChanges) {
      expect(BigInt(afterFence.tables[name]!.count)).toBe(BigInt(accessBaseline.tables[name]!.count) + 1n);
      expect(afterFence.tables[name]?.digest).not.toBe(accessBaseline.tables[name]?.digest);
    }
    for (const [name, coverage] of Object.entries(accessBaseline.tables)) {
      if (!sourceChanges.includes(name)) expect(afterFence.tables[name]).toEqual(coverage);
    }
    expect(await accessOutboxCoverage(accessPool)).toEqual(outboxBeforeFence);
    expect(afterFence.state).toEqual(await accessStateCoverage(accessPool));
    await accessPool.query(`CREATE TABLE access.probe_${nonce} (id uuid PRIMARY KEY, note text NOT NULL)`);
    const accessTable = await accessStateTables(accessPool);
    expect(accessTable.tables[`access.probe_${nonce}`]).toEqual({ count: '0', digest: emptyDigest });
    expect(accessTable.state.digest).not.toBe(afterFence.state.digest);
    await accessPool.query(`INSERT INTO access.probe_${nonce} (id, note) VALUES ($1, 'authority')`,
      [randomUUID()]);
    const accessRow = await accessStateCoverage(accessPool);
    expect(accessRow.count).toBe(String(BigInt(accessTable.state.count) + 1n));

    // The sealed Access manifest carries version 5 per-table coverage; older manifests fail by
    // version. The frontier needs the cluster superuser, whose row text must match the owner role's.
    const manifestCommand = join(root, 'services/main/src/access-recovery-manifest.ts');
    const env = { ...process.env, RECOVERY_MANIFEST_HMAC_KEY: manifestKey,
      ACCESS_RECOVERY_DATABASE_URL: `postgresql://postgres:${encodeURIComponent(
        compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/access` };
    const captured = spawnSync(process.execPath, [manifestCommand, 'capture'],
      { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    expect(captured.status, captured.stderr).toBe(0);
    const manifest = openRecoveryPayload<{ version: number; state: unknown;
      tables: Record<string, unknown> }>(captured.stdout, manifestKey, 'access-recovery-manifest');
    expect(manifest.version).toBe(5);
    expect(manifest.state).toEqual(accessRow);
    expect(manifest.tables[`access.probe_${nonce}`]).toEqual({ count: '1',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const legacyFile = join(directory, 'access-v4.json');
    writeFileSync(legacyFile, JSON.stringify(sealRecoveryPayload({
      pg: { systemIdentifier: '1', flushedLsn: '0/0', walFile: '0'.repeat(24) },
      outbox: await accessOutboxCoverage(accessPool), state: accessRow },
    manifestKey, 'access-recovery-manifest')));
    const legacy = spawnSync(process.execPath, [manifestCommand, 'verify', legacyFile],
      { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    expect(legacy.status).not.toBe(0);
    expect(legacy.stderr).toContain('Access recovery manifest version 4 is not version 5');
  } finally {
    try { await Promise.allSettled(pools.map(pool => pool.end())); }
    finally {
      try { if (started) stack('stack:reset', runId); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
}, 240_000);
