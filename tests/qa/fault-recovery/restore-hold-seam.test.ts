import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { applyQaSqlMigrations } from '../../../scripts/qa/bootstrap.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { migrateAccount } from '../../../scripts/ops/migrate.ts';
import { checkProductionEnv } from '../../../scripts/ops/production-env.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { DATASET, GRAPHS, RV, initializeFreshGraph, iri, type GraphLineage }
  from '../../../services/main/src/modules/work/activate.ts';
import { workRead, WorkReadUnavailable } from '../../../services/main/src/modules/work/read-session.ts';
import { workReadError } from '../../../services/main/src/routes/work-reads.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import {
  RESTORE_CUTOVER_CRASH_FLAG, RESTORE_CUTOVER_CRASH_POINTS, RestoreCutoverCrash,
  captureGraphRecoveryCoverage, cutoverRestoredGraphLineage, releaseRestoredGraphHold,
  restoreCutoverCrashArmed,
  type RestoreCutoverCrashPoint,
} from '../../../services/main/src/modules/work/restore-lineage.ts';
import { copyRecoveryTree } from '../support/recovery-copy.ts';
import { startPreparedPostgresCluster, type PostgresCluster } from '../support/postgres-cluster.ts';
import { requireFaultTier, root, rootCommand } from './search-ops-support.ts';

const recoveryKey = 'c4'.repeat(32);
const productionPaths = [
  'infra/dev/compose.yaml',
  'infra/dev/compose.qa.yaml',
  'infra/dev/compose.qa-raw-update.yaml',
  'infra/release/Dockerfile',
  'infra/release/entrypoint.ts',
  'scripts/dev/release-manifest.ts',
];

test('production compose and the release manifest do not arm the restore cutover crash seam', () => {
  expect(RESTORE_CUTOVER_CRASH_POINTS).toEqual([
    'after-hold-written',
    'after-epoch-swap-before-hold-clears',
  ]);
  for (const path of productionPaths) {
    expect(readFileSync(join(root, path), 'utf8'), path).not.toContain(RESTORE_CUTOVER_CRASH_FLAG);
  }
  expect(() => checkProductionEnv({ [RESTORE_CUTOVER_CRASH_FLAG]: '1' }, [])).toThrow(
    'Production forbids REZICS_QA_RESTORE_CUTOVER_CRASH');
  try { checkProductionEnv({}, []); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(RESTORE_CUTOVER_CRASH_FLAG);
  }
  const previousFlag = process.env[RESTORE_CUTOVER_CRASH_FLAG];
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env[RESTORE_CUTOVER_CRASH_FLAG];
    expect(restoreCutoverCrashArmed('after-hold-written')).toBe(false);
    process.env[RESTORE_CUTOVER_CRASH_FLAG] = '1';
    process.env.NODE_ENV = 'production';
    expect(restoreCutoverCrashArmed('after-hold-written')).toBe(false);
    expect(restoreCutoverCrashArmed('after-epoch-swap-before-hold-clears')).toBe(false);
  } finally {
    if (previousFlag === undefined) delete process.env[RESTORE_CUTOVER_CRASH_FLAG];
    else process.env[RESTORE_CUTOVER_CRASH_FLAG] = previousFlag;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('a cutover crash after the hold is written makes a Work read unavailable until release', async () => {
  requireFaultTier();
  const runId = `owner-cut-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const stackArgs = ['--profile', 'qa', '--run-id', runId];
  const state = join(root, '.temp', `restore-hold-seam-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const pools: Pool[] = [];
  let started = false;
  let restoredCluster: PostgresCluster | undefined;
  const previousFlag = process.env[RESTORE_CUTOVER_CRASH_FLAG];
  try {
    started = true;
    await rootCommand(['stack:up', ...stackArgs], 180_000);
    const stack = stackDirectory(root, { profile: 'qa', runId });
    const apps = readEnv(join(stack, 'apps.env'));
    const compose = readEnv(join(stack, 'compose.env'));
    const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    const content = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    const relay = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    const accountOwner = new Pool({ connectionString:
      `postgresql://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}`
      + `@127.0.0.1:${compose.POSTGRES_PORT}/account` });
    pools.push(access, content, relay, accountOwner);
    await applyQaSqlMigrations(apps.ACCESS_DATABASE_URL!, join(root, 'services/main/migrations/access'),
      schemaFiles(root, 'access'));
    await applyQaSqlMigrations(apps.ACCOUNT_RELAY_DATABASE_URL!, join(root, 'services/main/migrations/relay'),
      schemaFiles(root, 'relay'));
    await migrateContent(content);
    await migrateAccount(apps);
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: randomUUID(), routingEpoch: '1' };
    await initializeFreshGraph(fuseki, lineage);
    const consumer = `restore-hold:${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, lineage.dataEpoch);
    await engageAccessRecoveryFence(access);
    const objectDirectory = apps.MAIN_OBJECT_DIRECTORY!;
    mkdirSync(objectDirectory, { recursive: true });
    let coverage: Awaited<ReturnType<typeof captureGraphRecoveryCoverage>> | undefined;
    let captureError: unknown;
    for (let attempt = 0; attempt < 8 && !coverage; attempt++) {
      try {
        coverage = await captureGraphRecoveryCoverage(fuseki, accountOwner, access, relay, consumer, content,
          { directory: objectDirectory });
      } catch (error) {
        captureError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 7 || !/moved during recovery capture|WAL frontier|PostgreSQL/.test(message)) throw error;
        await Bun.sleep(200);
      }
    }
    if (!coverage) throw captureError instanceof Error ? captureError : new Error('recovery coverage is unavailable');
    const sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage, recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, sealedCoverage, recoveryKey);
    const next = { dataEpoch: randomUUID(), routingEpoch: '2' };
    const prior = { ...lineage, sequence: coverage.priorSequence };
    process.env[RESTORE_CUTOVER_CRASH_FLAG] = '1';
    const crashAt: RestoreCutoverCrashPoint = 'after-hold-written';
    await expect(cutoverRestoredGraphLineage(fuseki, { prior, next }, crashAt))
      .rejects.toBeInstanceOf(RestoreCutoverCrash);
    const observed = await cutoverControl(fuseki);
    // The epoch swap and the hold are one command. A bare cutover — sequence 0,
    // RestoreCutover, no hold, routing epoch left unchanged — is not produced
    // by after-hold-written or after-epoch-swap-before-hold-clears.
    expect(observed).toEqual({
      dataEpoch: next.dataEpoch, routingEpoch: next.routingEpoch, sequence: '0', hold: 'true',
    });
    expect(observed.routingEpoch).not.toBe(lineage.routingEpoch);
    expect(restoreCutoverCrashArmed('after-epoch-swap-before-hold-clears')).toBe(true);
    const readThrough = (readLineage: GraphLineage, accessPool: Pool) => workRead({
      environment: { fuseki, lineage: readLineage, objectDirectory },
      access: new AccessAdmissionRegistry(accessPool),
      account: { verify: async () => { throw new Error('this read is anonymous'); } },
    } as MainWorkDependencies, new Request('http://main.local/v1/works'), {}, async () => 'available' as const);
    let heldError: unknown;
    try { await readThrough(next, access); }
    catch (error) { heldError = error; }
    expect(heldError).toBeInstanceOf(WorkReadUnavailable);
    expect(heldError).toMatchObject({ message: 'Graph is unavailable' });
    expect(workReadError(heldError).status).toBe(503);
    expect(await cutoverRestoredGraphLineage(fuseki, { prior, next })).toEqual({
      lineage: next, sequence: '0', replayed: true,
    });
    expect(await cutoverControl(fuseki)).toMatchObject({ hold: 'true' });
    await expect(readThrough(next, access)).rejects.toThrow('Graph is unavailable');

    const backup = (await rootCommand(['stack:backup', ...stackArgs], 120_000)).trim().split('\n').at(-1)!;
    execFileSync('pg_verifybackup', ['--no-parse-wal', backup], { cwd: state, timeout: 15_000 });
    const restoredData = join(state, 'restored');
    copyRecoveryTree(backup, restoredData);
    appendFileSync(join(restoredData, 'postgresql.auto.conf'),
      "\narchive_mode = off\nrestore_command = 'false'\n");
    writeFileSync(join(restoredData, 'recovery.signal'), '');
    restoredCluster = await startPreparedPostgresCluster(restoredData, { role: 'postgres', password: compose.POSTGRES_PASSWORD });
    const restoredPool = (database: string) => {
      const pool = new Pool({ host: '127.0.0.1', port: restoredCluster!.port, database,
        user: 'postgres', password: compose.POSTGRES_PASSWORD! });
      pools.push(pool);
      return pool;
    };
    const restoredAccount = restoredPool('account');
    const restoredAccess = restoredPool('access');
    const restoredContent = restoredPool('content');
    const restoredRelay = restoredPool('relay');
    let recovering = true;
    for (let attempt = 0; attempt < 100 && recovering; attempt++) {
      recovering = (await restoredAccount.query<{ recovering: boolean }>(
        'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering ?? true;
      if (recovering) await Bun.sleep(100);
    }
    expect(recovering).toBe(false);
    await releaseRestoredGraphHold(fuseki, restoredAccess, relay, next, {
      sealedCoverage, hmacKey: recoveryKey, accountPool: restoredAccount, contentPool: restoredContent,
      objectStore: { directory: objectDirectory }, restoredRelayPool: restoredRelay,
      releaseErasures: async ({ accessClient, fenceGeneration }, releaseGraph) => {
        await releaseGraph();
        await releaseAccessRecoveryFence(accessClient, fenceGeneration);
      },
    });
    expect(await cutoverControl(fuseki)).toMatchObject({
      dataEpoch: next.dataEpoch, routingEpoch: next.routingEpoch, sequence: '0', hold: null,
    });
    expect(await readThrough(next, restoredAccess)).toBe('available');
  } finally {
    if (previousFlag === undefined) delete process.env[RESTORE_CUTOVER_CRASH_FLAG];
    else process.env[RESTORE_CUTOVER_CRASH_FLAG] = previousFlag;
    try { restoredCluster?.stop('immediate'); }
    finally {
      await Promise.allSettled(pools.map(pool => pool.end()));
      try { if (started) await rootCommand(['stack:reset', ...stackArgs], 120_000); }
      finally { rmSync(state, { recursive: true, force: true }); }
    }
  }
}, qaStartupTestTimeout(360_000));

async function cutoverControl(fuseki: FusekiClient): Promise<{
  dataEpoch: string; routingEpoch: string; sequence: string; hold: string | null;
}> {
  const rows = (await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?routing ?sequence ?hold WHERE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence .
      OPTIONAL { ${iri(DATASET)} rv:restoreHold ?hold }
    } } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.epoch || !rows[0].routing || !rows[0].sequence) {
    throw new Error('product control record is unavailable or ambiguous');
  }
  return {
    dataEpoch: rows[0].epoch.value, routingEpoch: rows[0].routing.value, sequence: rows[0].sequence.value,
    hold: rows[0].hold?.value ?? null,
  };
}
