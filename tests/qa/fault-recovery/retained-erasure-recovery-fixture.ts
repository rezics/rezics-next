import { expect, spyOn } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence, AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ensureFixtureScopeGate, grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { assertObjectRecoveryCoverage, type ObjectRecoveryStore } from '../../../services/main/src/modules/owner/object-coverage.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { retainErasureCoverage, verifyErasure } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { captureGraphRecoveryCoverage, cutoverRestoredGraphLineage, readGraphRecoverySource, readRestoredGraphReleaseExpectation, RestoreLineageConflict, type RecoveryCoverage, readRestoredGraphReleaseProof } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { copyRecoveryTree } from '../support/recovery-copy.ts';
import { startPreparedPostgresCluster, type PostgresCluster } from '../support/postgres-cluster.ts';
import { qaStack, pinnedImage, standaloneFuseki, fusekiSecrets, type StandaloneFuseki } from './search-ops-support.ts';
import { runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { createServer } from 'node:net';
import { getMigrations } from 'better-auth/db/migration';
import { accountAuthOptions, createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { installConsentRefreshFence } from '../../../services/account/src/consent-fence.ts';
import { captureDeletionRecoverySet } from '../../../services/account/src/deletion-recovery-set.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import * as admission from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { publishAdmittedContent } from '../../../services/main/src/modules/content-publication/publish-admitted.ts';
import { createAdmittedTextContribution } from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { selectAdmittedMainDefault } from '../../../services/main/src/modules/work/select-main-admitted.ts';
import { applyContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import { settleAccountErasures } from '../../../services/main/src/modules/erasure/account.ts';
import { readGraphErasureProof, suppressGraphContentRevisions, heldErasureMaintenanceClient } from '../../../services/main/src/modules/erasure/graph.ts';
import { ensureRetentionDomain, ERASURE_JOURNAL_EPOCH, journalErasure, markErasureSuppressed, readErasure, recordErasureInventory, sha256 } from '../../../services/main/src/modules/erasure/journal.ts';
import type { RestoredGraphCustody } from '../../../services/main/src/modules/erasure/custody.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { mirrorAccountDeletionIntent, mirrorAccountDeletionIntents } from '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { retainAccountSubjectDeletion } from '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import { initializeFreshGraph, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { ensureModelGeneration } from '../../../services/main/src/modules/semantic/command.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody } from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { OwnerOperations, OwnerOperationUnavailable } from '../../../services/main/src/modules/owner/operations.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';
import { createRestoreCopyDisposal } from './owner-restore-erasure-fixture.ts';

export class DirectoryObjects implements ImmutableObjects {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  async put(bytes: Uint8Array): Promise<string> {
    const digest = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(this.directory, digest), bytes);
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    let bytes: Buffer;
    try { bytes = readFileSync(join(this.directory, digest)); }
    catch { throw new ObjectUnavailable('retained fixture object is missing'); }
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new ObjectIntegrityError('retained fixture object differs');
    return bytes;
  }
}

type SourceOwners = { account: Pool; access: Pool; content: Pool; relay: Pool };
type RestoredOwnerPools = SourceOwners & { port: number };
type CandidateObjectRecoveryStore = ObjectRecoveryStore & {
  directory: string;
  workObjects: DirectoryObjects;
};
type RecoveryCandidate = RestoredOwnerPools & {
  graph: { url: string; fuseki: FusekiClient; lineage: { dataEpoch: string; routingEpoch: string } };
  objects: CandidateObjectRecoveryStore;
  dispose: () => Promise<void>;
};

export interface RetainedErasureRecoveryFixtureOptions {
  runId: string;
  state: string;
  source: SourceOwners;
  accountOwner: Pool;
  fuseki: FusekiClient;
  recoveryKey: string;
  objects: DirectoryObjects;
  quiesceAccount: () => Promise<void>;
  resumeAccount: () => Promise<void>;
}

export interface RetainedErasureRecoveryCut {
  backup: string;
  backupObjects: string;
  nativeSnapshot: RetainedErasureNativeSnapshot;
  coverage: RecoveryCoverage;
  sourceCut: Awaited<ReturnType<typeof readGraphRecoverySource>>;
  coveredEpoch: string | null;
  consumer: string;
  deletionSet: string | null;
  authority: { sealedCoverage: string; hmacKey: string };
  restoredFence: string;
  restore: () => Promise<{
    restored: RestoredOwnerPools;
    candidateGraph: RecoveryCandidate['graph'];
    candidateObjects: CandidateObjectRecoveryStore;
    dispose: () => Promise<void>;
  }>;
}

export interface RetainedErasureNativeSnapshot {
  readonly volume: string;
  readonly sourceCut: Awaited<ReturnType<typeof readGraphRecoverySource>>;
}

export function assertRetainedErasureNativeSnapshotMatches(
  sourceCut: Awaited<ReturnType<typeof readGraphRecoverySource>>,
  snapshot: RetainedErasureNativeSnapshot,
): void {
  if (!isDeepStrictEqual(sourceCut, snapshot.sourceCut))
    throw new Error('source graph cut changed before native snapshot reuse');
}

export function retainedObjectFiles(directory: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const visit = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path, relative);
      else if (entry.isFile()) found.push([relative, createHash('sha256').update(readFileSync(path)).digest('hex')]);
      else throw new Error('immutable object root contains a non-file entry');
    }
  };
  visit(directory, '');
  return found;
}

export async function constructRetainedErasureCandidatesInOrder<Cut, Candidate>(
  cuts: readonly [Cut, Cut, Cut],
  construct: (cut: Cut) => Promise<Candidate>,
): Promise<[Candidate, Candidate, Candidate]> {
  const [first, second, third] = cuts;
  const firstCandidate = await construct(first);
  const secondCandidate = await construct(second);
  const thirdCandidate = await construct(third);
  return [firstCandidate, secondCandidate, thirdCandidate];
}

export function createRetainedErasureRecoveryFixture(options: RetainedErasureRecoveryFixtureOptions) {
  const preparationStarted = Date.now();
  const artifactDirectory = process.env.REZICS_QA_ARTIFACT_DIR ?? options.state;
  const timingPath = join(artifactDirectory, `retained-erasure-recovery-fixture-${options.runId}-timings.json`);
  const timingRows: Array<{ phase: string; ordinal?: number; startedAt: string; durationMs: number | null }> = [];
  const subprocessRows: Array<{
    command: string; phase: string | null; startedAt: string; durationMs: number;
    status: number | null; signal: NodeJS.Signals | null;
    error: { code: string | undefined; message: string } | null;
    stdout: string; stderr: string;
  }> = [];
  const activeTimings = new Map<(typeof timingRows)[number], number>();
  const persistTimings = () => {
    for (const [row, started] of activeTimings) row.durationMs = Math.max(0, Math.round(performance.now() - started));
    writeFileSync(timingPath, JSON.stringify({ runId: options.runId, phases: timingRows,
      subprocesses: subprocessRows }, null, 2),
      { mode: 0o600 });
  };
  const timingPulse = setInterval(persistTimings, 5_000);
  timingPulse.unref();
  const phase = async <T>(name: string, action: () => Promise<T>, ordinal?: number): Promise<T> => {
    const row: (typeof timingRows)[number] = { phase: name, ...(ordinal === undefined ? {} : { ordinal }),
      startedAt: new Date().toISOString(), durationMs: null };
    const started = performance.now();
    timingRows.push(row);
    activeTimings.set(row, started);
    persistTimings();
    try { return await action(); }
    catch (error) { recordRetainedErasureFailure(error, name); throw error; }
    finally {
      row.durationMs = Math.max(0, Math.round(performance.now() - started));
      activeTimings.delete(row);
      persistTimings();
    }
  };
  const qa = qaStack(options.runId);
  const image = pinnedImage();
  const suffix = randomBytes(6).toString('hex');
  const pools = new Set<Pool>();
  const clusters: PostgresCluster[] = [];
  const containers: StandaloneFuseki[] = [];
  const volumes: string[] = [];
  const candidateDirectories = new Set<string>();
  let disposed = false;
  const assertPreparationBudget = () => {
    expect(Date.now() - preparationStarted).toBeLessThan(600_000);
  };

  const recordSubprocess = (command: string, run: () => SpawnSyncReturns<string>): string => {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = run();
    const evidence = { command, phase: [...activeTimings.keys()].at(-1)?.phase ?? null,
      startedAt, durationMs: Math.max(0, Math.round(performance.now() - started)),
      status: result.status, signal: result.signal,
      error: result.error ? { code: (result.error as NodeJS.ErrnoException).code,
        message: result.error.message } : null,
      stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    subprocessRows.push(evidence);
    persistTimings();
    if (result.status !== 0 || result.error) {
      throw new Error(`isolated erasure restore subprocess failed: ${JSON.stringify(evidence)}`);
    }
    return result.stdout.trim();
  };
  const subprocess = (command: string, program: string, args: string[], timeout: number): string =>
    recordSubprocess(command, () => spawnSync(program, args, {
      env: preserveReapEnvironment(qa.dockerEnv), encoding: 'utf8', timeout, maxBuffer: 2_000_000,
    }));
  const docker = (args: string[], timeout = 120_000, command = `docker ${args[0]}`): string =>
    recordSubprocess(command, () => spawnSync('docker', args, {
      env: preserveReapEnvironment(qa.dockerEnv), encoding: 'utf8', timeout, maxBuffer: 2_000_000,
    }));
  const removePool = async (pool: Pool): Promise<void> => {
    if (!pools.has(pool)) return;
    await pool.end();
    pools.delete(pool);
  };
  const removeCluster = (cluster: PostgresCluster): void => {
    if (!clusters.includes(cluster)) return;
    cluster.remove();
    const index = clusters.indexOf(cluster);
    if (index >= 0) clusters.splice(index, 1);
  };
  const removeContainer = (container: StandaloneFuseki): void => {
    if (!containers.includes(container)) return;
    container.remove();
    const index = containers.indexOf(container);
    if (index >= 0) containers.splice(index, 1);
  };
  const removeVolume = (name: string): void => {
    if (!volumes.includes(name)) return;
    let removeFailure: unknown;
    try { docker(['volume', 'rm', '-f', name], 30_000); }
    catch (error) { removeFailure = error; }
    let remaining: string[];
    try {
      remaining = docker(['volume', 'ls', '--quiet', '--filter', `name=${name}`], 30_000)
        .split(/\s+/).filter(value => value === name);
    } catch (error) {
      throw removeFailure ?? error;
    }
    if (remaining.length) throw removeFailure ?? new Error(`Docker volume ${name} remains after removal`);
    const index = volumes.indexOf(name);
    if (index >= 0) volumes.splice(index, 1);
  };
  const removeCandidateDirectory = (path: string): void => {
    if (!candidateDirectories.has(path)) return;
    if (clusters.some(cluster => cluster.directory === path
      || cluster.dataDirectory === path || cluster.directory.startsWith(`${path}/`))) {
      throw new Error(`candidate PostgreSQL at ${path} is not safe to remove while running`);
    }
    rmSync(path, { recursive: true, force: true });
    if (existsSync(path)) throw new Error(`candidate directory ${path} remains after removal`);
    candidateDirectories.delete(path);
  };
  const volume = (label: string): string => {
    const name = `rezics-erasure-restore-${suffix}-${label}`;
    volumes.push(name);
    docker(['volume', 'create', name], 30_000);
    return name;
  };
  const copyGraph = (from: string, to: string): void => {
    docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--volume', `${from}:/from:ro`,
      '--volume', `${to}:/to`, '--entrypoint', 'sh', image, '-ec', 'cp -a /from/rezics /to/rezics']);
  };
  const createCandidate = async (cut: {
    name: string; ordinal: number; backupPostgres: string; backupObjects: string;
    nativeVolume: string; coverage: RecoveryCoverage; sourceCut: Awaited<ReturnType<typeof readGraphRecoverySource>>;
    fenceGeneration: string; objectFiles: Array<[string, string]>;
  }): Promise<RecoveryCandidate> => {
    if (disposed) throw new Error('retained erasure recovery fixture is disposed');
    const { name, ordinal, backupPostgres, backupObjects, nativeVolume, coverage, sourceCut,
      fenceGeneration, objectFiles } = cut;
    const candidatePools = new Set<Pool>();
    const candidateContainers = new Set<StandaloneFuseki>();
    const candidateVolumes = new Set<string>();
    const ownedDirectories = new Set<string>();
    let candidateCluster: PostgresCluster | undefined;
    let candidateVolume: string | undefined;
    const ownerCopy = await phase('candidate.postgres-restore-startup', async () => {
      const candidateDirectory = join(options.state, `candidate-${name}-${ordinal}`);
      const postgresDirectory = join(candidateDirectory, 'postgres');
      candidateDirectories.add(candidateDirectory);
      ownedDirectories.add(candidateDirectory);
      mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
      copyRecoveryTree(backupPostgres, postgresDirectory);
      // Preserve durable recovery without opening every copied relation for fsync.
      // https://www.postgresql.org/docs/18/runtime-config-error-handling.html#GUC-RECOVERY-INIT-SYNC-METHOD
      appendFileSync(join(postgresDirectory, 'postgresql.auto.conf'),
        "\narchive_mode = off\nrestore_command = 'false'\n"
          + (process.platform === 'linux' ? "recovery_init_sync_method = 'syncfs'\n" : ''));
      writeFileSync(join(postgresDirectory, 'recovery.signal'), '');
      const cluster = await startPreparedPostgresCluster(postgresDirectory, { role: 'postgres', password: qa.composeEnv.POSTGRES_PASSWORD });
      clusters.push(cluster);
      candidateCluster = cluster;
      const pool = (database: string) => {
        const value = new Pool({ host: '127.0.0.1', port: cluster.port, database, user: 'postgres',
          password: qa.composeEnv.POSTGRES_PASSWORD!, max: 4, connectionTimeoutMillis: 2_000 });
        pools.add(value);
        candidatePools.add(value);
        return value;
      };
      const account = pool('account');
      const access = pool('access');
      const content = pool('content');
      const relay = pool('relay');
      let recovering = true;
      for (let attempt = 0; attempt < 100 && recovering; attempt++) {
        recovering = (await account.query<{ recovering: boolean }>(
          'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering ?? true;
        if (recovering) await Bun.sleep(100);
      }
      expect(recovering).toBe(false);
      return { cluster, account, access, content, relay };
    }, ordinal);
    const { cluster, account, access, content, relay } = ownerCopy;

    const graphCopy = await phase('candidate.native-graph-copy-cutover', async () => {
      candidateVolume = volume(`candidate-${name}-${ordinal}`);
      candidateVolumes.add(candidateVolume);
      copyGraph(nativeVolume, candidateVolume);
      const graph = await standaloneFuseki(qa.dockerEnv, {
        name: `rezics-erasure-restore-${suffix}-${name}-${ordinal}`,
        image,
        volume: candidateVolume,
        secrets: fusekiSecrets(qa.composeEnv),
      }, { onAllocated: value => { containers.push(value); candidateContainers.add(value); } });
      const fuseki = new FusekiClient(graph.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN!,
        qa.composeEnv.FUSEKI_COMMAND_TOKEN!);
      const next = { dataEpoch: randomUUID(), routingEpoch:
        /^(0|[1-9][0-9]*)$/.test(sourceCut.routingEpoch)
          ? (BigInt(sourceCut.routingEpoch) + 1n).toString() : randomUUID() };
      await cutoverRestoredGraphLineage(fuseki, { prior: {
        dataEpoch: sourceCut.dataEpoch, routingEpoch: sourceCut.routingEpoch, sequence: sourceCut.sequence,
      }, next });

      const accessFence = (await access.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
      expect(accessFence).toEqual({ open: false, generation: fenceGeneration });
      const expectation = await readRestoredGraphReleaseExpectation(fuseki, next, coverage);
      expect(expectation.saved).toEqual({ dataEpoch: sourceCut.dataEpoch, graphSequence: sourceCut.sequence,
        main: { streamScope: coverage.relay.streamScope, dataEpoch: sourceCut.dataEpoch,
          sequence: coverage.relay.sequence } });
      expect(expectation.effective).toEqual(expectation.saved);
      expect((await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
        GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:restoreHold true } }`)).boolean).toBe(true);
      return { url: graph.url, fuseki, lineage: next };
    }, ordinal);

    const candidateObjects = await phase('candidate.object-copy-verification', async () => {
      const candidateObjectsDirectory = join(options.state, `objects-${name}-${ordinal}`);
      candidateDirectories.add(candidateObjectsDirectory);
      ownedDirectories.add(candidateObjectsDirectory);
      cpSync(backupObjects, candidateObjectsDirectory, { recursive: true });
      const candidateObjects = new DirectoryObjects(candidateObjectsDirectory);
      expect(retainedObjectFiles(candidateObjectsDirectory)).toEqual(objectFiles);
      if (!coverage.objects) throw new Error('signed object coverage is absent');
      await assertObjectRecoveryCoverage(graphCopy.fuseki, { directory: candidateObjectsDirectory,
        workObjects: candidateObjects }, coverage.objects);
      return { directory: candidateObjectsDirectory, workObjects: candidateObjects };
    }, ordinal);
    expect(relay).not.toBe(options.source.relay);
    expect(cluster.port).not.toBe(Number(qa.composeEnv.POSTGRES_PORT));
    expect(await relayCoverage(relay, coverage.relay.consumer)).toEqual(coverage.relay);
    assertPreparationBudget();
    const disposeCandidate = createRestoreCopyDisposal([
      ...[...candidatePools].map((pool, index) => ({
        resource: `candidate ${name} PostgreSQL pool ${index + 1}`,
        run: () => removePool(pool),
      })),
      ...(candidateContainers.size ? [...candidateContainers].map((container, index) => ({
        resource: `candidate ${name} graph ${index + 1}`,
        run: () => removeContainer(container),
      })) : []),
      ...(candidateCluster ? [{ resource: `candidate ${name} PostgreSQL`,
        run: () => removeCluster(candidateCluster!) }] : []),
      ...[...candidateVolumes].map((candidateVolumeName, index) => ({
        resource: `candidate ${name} graph volume ${index + 1}`,
        run: () => removeVolume(candidateVolumeName),
      })),
      ...[...ownedDirectories].map((directory, index) => ({
        resource: `candidate ${name} directory ${index + 1}`,
        run: () => removeCandidateDirectory(directory),
      })),
    ]);
    const dispose = () => phase('candidate.disposal', disposeCandidate, ordinal);
    return { account, access, content, relay, port: cluster.port,
      graph: graphCopy,
      objects: candidateObjects, dispose };
  };

  const captureAndRestore = async (name: string, input: {
    captureDeletionSet?: () => Promise<string>;
    reuseNativeSnapshot?: RetainedErasureNativeSnapshot;
  } = {}): Promise<RetainedErasureRecoveryCut> => {
    if (disposed) throw new Error('retained erasure recovery fixture is disposed');
    const consumer = `erasure-restore-${randomUUID()}`;
    let fenceGeneration: string | undefined;
    let accountQuiesced = false;
    let graphStopAttempted = false;
    let fenceReleased = false;
    try {
      await phase('capture.quiesce-and-access-fence', async () => {
        await options.quiesceAccount();
        accountQuiesced = true;
        fenceGeneration = await engageAccessRecoveryFence(options.source.access);
      });
      if (!fenceGeneration) throw new Error('source Access recovery fence is unavailable');
      const capture = await phase('capture.signed-owner-coverage', async () => {
        const sourceCut = await readGraphRecoverySource(options.fuseki);
        if (input.reuseNativeSnapshot)
          assertRetainedErasureNativeSnapshotMatches(sourceCut, input.reuseNativeSnapshot);
        await initializeRelayCheckpoint(options.source.relay, consumer, sourceCut.dataEpoch);
        for (let batch = 0; batch < 32; batch++) {
          if (!await relayMainOutboxOnce(options.fuseki, options.source.relay, consumer)) break;
          if (batch === 31) throw new Error('source relay drain exceeded its bound');
        }
        let coverage: RecoveryCoverage | undefined;
        for (let attempt = 0; attempt < 8 && !coverage; attempt++) {
          try {
            coverage = await captureGraphRecoveryCoverage(options.fuseki, options.accountOwner,
              options.source.access, options.source.relay, consumer, options.source.content,
              { directory: options.objects.directory, workObjects: options.objects });
          } catch (error) {
            if (!(error instanceof RestoreLineageConflict) || !error.message.includes('Account WAL frontier')
              || attempt === 7) throw error;
            await Bun.sleep(100);
          }
        }
        if (!coverage) throw new Error('signed owner recovery coverage did not stabilize');
        expect(coverage.priorDataEpoch).toBe(sourceCut.dataEpoch);
        expect(coverage.priorSequence).toBe(sourceCut.sequence);
        expect(coverage.relay.streamScope).toBe(sourceCut.relay.streamScope);
        expect(coverage.relay.dataEpoch).toBe(sourceCut.relay.dataEpoch);
        expect(coverage.relay.sequence).toBe(sourceCut.relay.sequence);
        expect(coverage.objects).toBeDefined();
        expect(Number(coverage.objects!.objectCount)).toBeGreaterThan(0);
        const objectFiles = retainedObjectFiles(options.objects.directory);
        const deletionSet = input.captureDeletionSet ? await input.captureDeletionSet() : null;
        const sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage,
          options.recoveryKey, 'graph-recovery-coverage'));
        await retainRecoveryCoverageHead(options.source.relay, sealedCoverage, options.recoveryKey);
        const coveredEpoch = await retainErasureCoverage(options.source.relay, consumer);
        return { sourceCut, coverage, objectFiles, deletionSet, sealedCoverage, coveredEpoch };
      });
      const { sourceCut, coverage, objectFiles, deletionSet, sealedCoverage, coveredEpoch } = capture;
      const backup = join(options.state, name);
      mkdirSync(backup, { recursive: true, mode: 0o700 });
      const backupPostgres = join(backup, 'postgres');
      const backupObjects = join(backup, 'objects');
      await phase('capture.object-backup', async () => {
        cpSync(options.objects.directory, backupObjects, { recursive: true });
        expect(retainedObjectFiles(backupObjects)).toEqual(objectFiles);
      });

      let nativeSnapshot = input.reuseNativeSnapshot;
      if (!nativeSnapshot) {
        const nativeVolume = volume(`native-${name}`);
        await phase('capture.native-graph-snapshot', async () => {
          graphStopAttempted = true;
          optionsStackStop();
          copyGraph(qa.stateVolume, nativeVolume);
        });
        nativeSnapshot = { volume: nativeVolume, sourceCut };
      }

      await phase('capture.postgres-backup', async () => {
        try {
          const remote = `/tmp/rezics-erasure-${suffix}-${name}`;
          const container = docker(['ps', '--quiet', '--no-trunc',
            '--filter', `label=com.docker.compose.project=${qa.project}`,
            '--filter', 'label=com.docker.compose.service=postgres'], 10_000);
          if (!/^[0-9a-f]{12,64}$/.test(container)) throw new Error('source PostgreSQL container is unavailable');
          try {
            docker(['exec', '-u', 'postgres', container, 'sh', '-ec',
              `PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -p 5432 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast --sync-method=syncfs --verbose --progress`],
            65_000, 'pg_basebackup');
            docker(['cp', `${container}:${remote}`, backupPostgres]);
            subprocess('pg_verifybackup', 'pg_verifybackup', ['--no-parse-wal', backupPostgres], 15_000);
          } catch (error) {
            recordRetainedErasureFailure(error, 'capture.postgres-backup-copy');
            throw error;
          } finally {
            docker(['exec', '-u', 'postgres', container, 'rm', '-rf', remote], 10_000);
          }
        } catch (error) {
          recordRetainedErasureFailure(error, 'capture.postgres-backup');
          throw error;
        } finally {
          if (graphStopAttempted) {
            await qa.runner.start();
            graphStopAttempted = false;
          }
        }
      });

      const authority = { sealedCoverage, hmacKey: options.recoveryKey };
      const captured = { name, backupPostgres, backupObjects, nativeVolume: nativeSnapshot.volume, coverage, sourceCut,
        fenceGeneration, objectFiles };
      let candidateOrdinal = 0;
      const restore = async () => {
        const candidate = await createCandidate({ ...captured, ordinal: ++candidateOrdinal });
        const { graph: candidateGraph, objects: candidateObjects, dispose, ...restored } = candidate;
        return { restored, candidateGraph, candidateObjects, dispose };
      };
      expect(await readGraphRecoverySource(options.fuseki)).toEqual(sourceCut);
      expect(retainedObjectFiles(options.objects.directory)).toEqual(objectFiles);
      await releaseAccessRecoveryFence(options.source.access, fenceGeneration);
      fenceReleased = true;
      await options.resumeAccount();
      accountQuiesced = false;
      assertPreparationBudget();
      return { backup, backupObjects, nativeSnapshot, coverage, sourceCut, coveredEpoch, consumer, deletionSet,
        authority, restoredFence: fenceGeneration, restore };
    } catch (error) {
      recordRetainedErasureFailure(error, 'capture');
      throw error;
    } finally {
      if (graphStopAttempted) await qa.runner.start();
      if (!fenceReleased && fenceGeneration) await releaseAccessRecoveryFence(options.source.access, fenceGeneration);
      if (accountQuiesced) await options.resumeAccount();
    }

    function optionsStackStop() { qa.runner.stop(); }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    try {
      await phase('fixture.final-disposal', async () => {
        for (const pool of [...pools]) {
          try { await removePool(pool); } catch (error) { failures.push(error); }
        }
        for (const cluster of [...clusters].reverse()) {
          try { removeCluster(cluster); } catch (error) { failures.push(error); }
        }
        for (const container of [...containers].reverse()) {
          try { removeContainer(container); } catch (error) { failures.push(error); }
        }
        for (const name of [...volumes].reverse()) {
          try { removeVolume(name); } catch (error) { failures.push(error); }
        }
        for (const directory of [...candidateDirectories].reverse()) {
          try { removeCandidateDirectory(directory); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'retained erasure recovery cleanup failed');
      });
    } finally {
      clearInterval(timingPulse);
      persistTimings();
    }
  };

  return { captureAndRestore, dispose, phase };
}

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'c5'.repeat(32);

async function rootCommand(args: string[], timeout: number): Promise<string> {
  const result = await runQaAdmissionChildAsync(root, ...scriptCommand(args), timeout);
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
  return result.stdout.trim();
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no fixture port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function migrate(pool: Pool, owner: 'access' | 'relay'): Promise<void> {
  const directory = join(root, `services/main/migrations/${owner}`);
  for (const file of schemaFiles(root, owner)) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
  }
}

export async function createRetainedErasureRestoreScenario() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `owner-cut-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent'];
  const state = join(root, '.temp', `erasure-restore-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const pools: Pool[] = [];
  const replayClusters: PostgresCluster[] = [];
  let app: ReturnType<typeof createAccountApp> | undefined;
  let recoveryFixture: ReturnType<typeof createRetainedErasureRecoveryFixture> | undefined;
  let started = false;
  const dispose = async () => {
    try {
      await recoveryFixture?.dispose();
    } finally {
      try {
        await app?.stop();
        await Promise.allSettled(pools.map(pool => pool.end()));
        for (const cluster of replayClusters) cluster.remove();
      } finally {
        try { if (started) await rootCommand(['stack:reset', ...stackArgs], 120_000); }
        finally { rmSync(state, { recursive: true, force: true }); }
      }
    }
  };
  try {
    started = true;
    await rootCommand(['stack:up', ...stackArgs], 180_000);
    const stack = stackDirectory(root, { profile: 'qa', runId, persistent: true });
    const apps = readEnv(join(stack, 'apps.env'));
    const compose = readEnv(join(stack, 'compose.env'));
    const account = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
    const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    const relay = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    const accountOwner = new Pool({ connectionString:
      `postgresql://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}`
        + `@127.0.0.1:${compose.POSTGRES_PORT}/account` });
    pools.push(account, access, contentPool, relay, accountOwner);
    await migrate(access, 'access');
    await migrate(relay, 'relay');
    await migrateContent(contentPool);

    // Real Account owner whose deletion hook fences Access and journals the tombstone.
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const issuer = `${baseURL}/api/auth`;
    const registry = new AccessAdmissionRegistry(access);
    const operators = new Set<string>();
    const config = { baseURL, secret: apps.ACCOUNT_SECRET!, resource: apps.ACCOUNT_MAIN_RESOURCE!,
      pool: account, operatorUserIds: operators,
      accessDeletionFence: async (subject: string) => {
        const fence = await registry.strongDeactivateAccountSubject(issuer, subject);
        if (fence) await mirrorAccountDeletionIntent(access, relay, fence.principalId, fence.enforcementEpoch);
        await retainAccountSubjectDeletion(relay, issuer, subject);
      } };
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    await installConsentRefreshFence(account);
    const auth = createAccountAuth(config);
    app = createAccountApp(auth, account).listen({ hostname: '127.0.0.1', port });
    const signUp = async (name: string) => {
      const email = `${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${baseURL}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }) });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        cookie: response.headers.get('set-cookie')!, password };
    };
    const erased = await signUp('erased');
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: baseURL });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Erasure restore verifier', scope: 'access:manage',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['access:manage'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const browserClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Erasure restore browser', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid access:manage work:create work:edit work:read',
        skip_consent: true, require_pkce: true } });
    const refreshOperatorToken = async () => (await signIn({
      account: baseURL, clientId: browserClient.client_id, redirectUri,
      scope: 'openid access:manage work:create work:edit work:read', resource: apps.ACCOUNT_MAIN_RESOURCE!,
    }, operator.cookie)).accessToken;
    const token = await refreshOperatorToken();
    const verifier = new AccountAssertionVerifier({ issuer, audience: apps.ACCOUNT_MAIN_RESOURCE!,
      jwksUrl: `${baseURL}/api/auth/jwks`, introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });

    // Access: the erased member's principal and the operator's erasure authority on one Work.
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const [erasedPrincipal, operatorPrincipal] = [randomUUID(), randomUUID()];
    await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $3, $4), ($2, $3, $5)`, [erasedPrincipal, operatorPrincipal, issuer, erased.id, operator.id]);
    await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    const laterAuthorityScope = `authority:restore:${randomUUID()}`;
    await ensureFixtureScopeGate(access, laterAuthorityScope);

    // Retained frontier: signed coverage head plus the erasure journal epoch it covered.
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    let lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    await initializeFreshGraph(fuseki, lineage);
    const objects = new DirectoryObjects(join(state, 'objects'));
    const workEnvironment: WorkActivationEnvironment = { fuseki, lineage,
      objectDirectory: objects.directory, workObjects: objects };
    await ensureModelGeneration(workEnvironment);
    const request = new Request('http://main.local/v1/works', {
      headers: { authorization: `Bearer ${token}` } });
    const grant = (scope: string, action: string) => grantFixtureAuthority(access, {
      scope, requireDispatch: true,
      representations: [{ principalId: operatorPrincipal, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' },
    });
    await grant('work:create:root', 'work.create');
    const createdWork = await createAdmittedMetadataWork(workEnvironment, verifier, registry, request, {
      title: 'Retained erasure recovery Work', language: 'en', actingSubject: actor,
      idempotencyKey: `erasure-restore-work-${randomUUID()}` });
    const work = createdWork.work;
    expect((await access.query<{ state: string; graph_outcome: string; graph_receipt: string;
      graph_data_epoch: string; graph_sequence: string }>(`SELECT state, graph_outcome, graph_receipt,
      graph_data_epoch, graph_sequence FROM access.admission WHERE id = $1`,
    [createdWork.admissionId])).rows[0]).toEqual({ state: 'sealed', graph_outcome: 'succeeded',
      graph_receipt: createdWork.receipt, graph_data_epoch: createdWork.dataEpoch,
      graph_sequence: createdWork.sequence });
    await grant(`erasure:${work}`, 'erasure.request');

    // Content targets include one API-erased payload, one published later target,
    // one target for the stale-journal case and unrelated public text.
    const content = new ContentCore(contentPool);
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const variant = { id: variantId, resourceId: work,
      language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
    const staleVariant = { ...variant, id: `urn:rezics:variant:${randomUUID()}` };
    const heads = new Map<string, string | null>();
    const save = async (body: string, targetVariant = variant) => {
      const expectedHead = heads.get(targetVariant.id) ?? null;
      const saved = await content.saveDraft({ operationId: `erasure-restore-${randomUUID()}`, variant: targetVariant,
        expectedHead, model: 'content-shape-v1', sourceRevision: null,
        provenance: { fixture: 'erasure-restore' }, serializedJson: JSON.stringify({ body }) });
      if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('Content save failed');
      heads.set(targetVariant.id, saved.revisionId);
      return { revisionId: saved.revisionId, position: saved.position };
    };
    const payloadBody = 'private payload that must not come back';
    const payloadSaved = await save(payloadBody);
    const unrelatedSaved = await save('unrelated public text');
    const laterSaved = await save('later erasure target');
    const staleTargetSaved = await save('stale-journal erasure target', staleVariant);
    const { revisionId: payload } = payloadSaved;
    const { revisionId: unrelated } = unrelatedSaved;
    const { revisionId: later } = laterSaved;
    const { revisionId: staleTarget } = staleTargetSaved;
    recoveryFixture = createRetainedErasureRecoveryFixture({
      runId, state, source: { account, access, content: contentPool, relay }, accountOwner, fuseki,
      recoveryKey, objects,
      quiesceAccount: async () => { await app?.stop(); app = undefined; },
      resumeAccount: async () => {
        if (!app) app = createAccountApp(auth, account).listen({ hostname: '127.0.0.1', port });
      },
    });
    const captureAndBackup = async (name: string, reuseNativeSnapshot?: RetainedErasureNativeSnapshot) => {
      const captured = await recoveryFixture!.captureAndRestore(name, {
        ...(name === 'before' ? {} : { captureDeletionSet: async () => JSON.stringify(sealRecoveryPayload(
          await captureDeletionRecoverySet(accountOwner, access, issuer, erased.id),
          recoveryKey, 'deletion-recovery-set')) }),
        ...(reuseNativeSnapshot ? { reuseNativeSnapshot } : {}),
      });
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60_000);
      for (const owner of ['account', 'content'] as const) {
        await ensureRetentionDomain(relay, { label: `${owner}:backup:${name}:${runId}`, owner,
          store: 'postgresql', custody: 'backup', expiresAt });
      }
      return { ...captured, expiresAt };
    };
    const credentials = async (pool: Pool, subject: string) => (await pool.query<{ users: string;
      passwords: string; sessions: string }>(`SELECT (SELECT count(*) FROM "user" WHERE id = $1)::text AS users,
      (SELECT count(*) FROM "account" WHERE "userId" = $1)::text AS passwords,
      (SELECT count(*) FROM "session" WHERE "userId" = $1)::text AS sessions`, [subject])).rows[0];
    const exact = async (pool: Pool, id: string) =>
      (await new ContentCore(pool).readExactBatch([id], async ids => new Set(ids)))[0];
    const drainMainRelay = async (consumer: string) => {
      for (let batch = 0; batch < 32; batch++) {
        if (!await relayMainOutboxOnce(fuseki, relay, consumer)) return;
      }
      throw new Error('erasure restore Main relay drain exceeded its bound');
    };
    const readSourceAfterDrain = async (consumer: string) => {
      const expected = await readGraphRecoverySource(fuseki);
      await drainMainRelay(consumer);
      const sourceCut = await readGraphRecoverySource(fuseki);
      expect(sourceCut).toEqual(expected);
      const checkpoint = (await relay.query<{ stream_scope: string; data_epoch: string; sequence: string }>(
        `SELECT stream_scope, data_epoch, sequence::text FROM relay.checkpoint WHERE consumer = $1`,
        [consumer])).rows[0];
      expect(checkpoint).toEqual({ stream_scope: sourceCut.relay.streamScope,
        data_epoch: sourceCut.relay.dataEpoch, sequence: sourceCut.relay.sequence });
      return sourceCut;
    };

    // Backup 1 predates Account and Content erasure, with the admitted Work and drafts present.
    const first = await captureAndBackup('before');
    expect(first.sourceCut).toEqual(await readGraphRecoverySource(fuseki));

    const bindCandidate = async (cut: typeof first) => {
      const candidate = await cut.restore();
      const { restored, candidateGraph, candidateObjects } = candidate;
      const accessFence = (await restored.access.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
      expect(accessFence).toEqual({ open: false, generation: cut.restoredFence });
      const graphRelease = await readRestoredGraphReleaseExpectation(
        candidateGraph.fuseki, candidateGraph.lineage, cut.coverage);
      expect(graphRelease.saved).toEqual({ dataEpoch: cut.sourceCut.dataEpoch,
        graphSequence: cut.sourceCut.sequence, main: { streamScope: cut.coverage.relay.streamScope,
          dataEpoch: cut.sourceCut.relay.dataEpoch, sequence: cut.sourceCut.relay.sequence } });
      expect(graphRelease.effective).toEqual(graphRelease.saved);
      const receiptCustody = new ReceiptCustody(new PostgresReceiptCustodyStore(restored.access),
        candidateObjects.workObjects, candidateGraph.fuseki, compose.FUSEKI_TITLE_ADMISSION_KEY!,
        proofRetirementSender(candidateGraph.url, compose.FUSEKI_COMMAND_TOKEN!));
      const graph: RestoredGraphCustody = {
        fuseki: candidateGraph.fuseki,
        lineage: candidateGraph.lineage,
        receiptCustody,
        heldErasure: {
          cut: { ...candidateGraph.lineage, restoreCutover: graphRelease.restoreCutover,
            priorDataEpoch: graphRelease.saved.dataEpoch, priorSequence: graphRelease.saved.graphSequence },
          accessHoldGeneration: accessFence!.generation,
          signingKey: compose.FUSEKI_TITLE_ADMISSION_KEY!,
          maintenance: heldErasureMaintenanceClient(candidateGraph.url, compose.FUSEKI_MAINTENANCE_TOKEN!),
          originalSource: 'retained-native-event',
        },
      };
      return { ...candidate, restoredFence: cut.restoredFence, restored: { ...restored, graph,
        objects: candidateObjects }, receiptCustody };
    };
    const readFindings = async (reconciliationId: string) => (await relay.query<{
      owner: string; item_kind: string; item_ref: string; disposition: string; evidence_digest: string;
    }>(`SELECT owner, item_kind, item_ref, disposition, evidence_digest
      FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1
      ORDER BY ordinal`, [reconciliationId])).rows;
    const expectFinding = (findings: Awaited<ReturnType<typeof readFindings>>, expected: {
      owner: string; item_kind: string; item_ref: string; disposition: string;
    }) => expect(findings).toContainEqual(expect.objectContaining(expected));
    const expectFindingPrefix = (findings: Awaited<ReturnType<typeof readFindings>>, expected: {
      owner: string; item_kind: string; item_refPrefix: string; disposition: string;
    }) => expect(findings.some(finding => finding.owner === expected.owner
      && finding.item_kind === expected.item_kind && finding.item_ref.startsWith(expected.item_refPrefix)
      && finding.disposition === expected.disposition)).toBe(true);
    const expectCustodyFindings = (findings: Awaited<ReturnType<typeof readFindings>>) => {
      expectFinding(findings, { owner: 'object', item_kind: 'payload',
        item_ref: 'retained-command-model-custody', disposition: 'matched' });
      expectFindingPrefix(findings, { owner: 'object', item_kind: 'receipt',
        item_refPrefix: 'retained-custody-roots:', disposition: 'matched' });
      expectFindingPrefix(findings, { owner: 'graph', item_kind: 'authority_fence',
        item_refPrefix: 'restored-graph-binding:', disposition: 'matched' });
      expectFindingPrefix(findings, { owner: 'relay', item_kind: 'receipt',
        item_refPrefix: 'restore-reconciliation:', disposition: 'matched' });
    };
    const expectBothHoldsClosed = async (candidate: Awaited<ReturnType<typeof bindCandidate>>) => {
      const { restored } = candidate;
      expect((await restored.access.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0])
        .toEqual({ open: false, generation: candidate.restoredFence });
      expect((await restored.graph!.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
        GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product>
          rv:dataEpoch "${restored.graph!.lineage.dataEpoch}" ;
          rv:routingEpoch "${restored.graph!.lineage.routingEpoch}" ; rv:sequence 0 ; rv:restoreHold true . } }`)).boolean)
        .toBe(true);
    };
    const ownerOperationFor = (candidate: Awaited<ReturnType<typeof bindCandidate>>,
      cut: Awaited<ReturnType<typeof captureAndBackup>>) => {
      const environment: WorkActivationEnvironment = {
        fuseki: candidate.candidateGraph.fuseki,
        lineage: candidate.candidateGraph.lineage,
        objectDirectory: candidate.candidateObjects.directory,
        workObjects: candidate.candidateObjects.workObjects,
        receiptCustody: candidate.receiptCustody,
      };
      return new OwnerOperations(relay, environment, {
        accountPool: candidate.restored.account,
        accessPool: candidate.restored.access,
        contentPool: candidate.restored.content,
        restoredRelayPool: candidate.restored.relay,
        hmacKey: recoveryKey,
        objectStore: {
          directory: candidate.candidateObjects.directory,
          workObjects: candidate.candidateObjects.workObjects,
          structureObjects: candidate.candidateObjects.workObjects,
        },
        erasures: {
          authority: cut.authority,
          originalSource: 'retained-native-event',
          signingKey: compose.FUSEKI_TITLE_ADMISSION_KEY!,
          maintenance: heldErasureMaintenanceClient(candidate.candidateGraph.url,
            compose.FUSEKI_MAINTENANCE_TOKEN!),
        },
      });
    };
    const interruptBeforeOwnerRelease = async (candidate: Awaited<ReturnType<typeof bindCandidate>>,
      cut: Awaited<ReturnType<typeof captureAndBackup>>, operations: OwnerOperations, key: string) => {
      const lock = admission.lockAccessRecoveryFenceForRelease;
      let interrupted = false;
      const interruption = spyOn(admission, 'lockAccessRecoveryFenceForRelease').mockImplementation(
        async (client, generation) => {
          if (!interrupted) {
            interrupted = true;
            throw new Error('transient interruption before native restore release');
          }
          return lock(client, generation);
        });
      try {
        await expect(operations.reconcileRestore({ sealedCoverage: cut.authority.sealedCoverage,
          sealedDeletionSets: cut.deletionSet ? [cut.deletionSet] : [] }, key))
          .rejects.toBeInstanceOf(OwnerOperationUnavailable);
      } finally { interruption.mockRestore(); }
      expect(interrupted).toBe(true);
      const outerOperationId = `owner:reconcile:${key}`;
      const outer = (await relay.query<{ id: string; state: string; hold_reason: string | null }>(
        'SELECT id, state, hold_reason FROM relay.owner_reconciliation WHERE operation_id = $1',
        [outerOperationId])).rows[0];
      expect(outer).toMatchObject({ state: 'running', hold_reason: null });
      const bindings = (await relay.query<{ item_ref: string }>(`SELECT item_ref
        FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1
          AND item_ref LIKE 'restore-%' ORDER BY ordinal`, [outer!.id])).rows.map(row => row.item_ref);
      expect(bindings.filter(ref => ref.startsWith('restore-qualification:'))).toHaveLength(1);
      expect(bindings.filter(ref => ref.startsWith('restore-release:'))).toEqual([]);
      const graphRelease = await readRestoredGraphReleaseExpectation(
        candidate.candidateGraph.fuseki, candidate.candidateGraph.lineage, cut.coverage);
      expect(await readRestoredGraphReleaseProof(candidate.candidateGraph.fuseki, graphRelease)).toBeNull();
      await expectBothHoldsClosed(candidate);
      return { outerOperationId, outerId: outer!.id };
    };

    // IAM11: Account erasure through the Account owner, then journal settlement.
    const deletion = await fetch(`${baseURL}/api/auth/delete-user`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: erased.cookie, origin: baseURL },
      body: JSON.stringify({ password: erased.password }) });
    expect(deletion.status).toBe(200);
    expect(await credentials(account, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await credentials(account, operator.id)).toMatchObject({ users: '1' });
    await mirrorAccountDeletionIntents(access, relay);
    expect(await settleAccountErasures(relay, access, account)).toBe(1);
    const accountErasureId = (await relay.query<{ id: string }>(
      'SELECT id FROM relay.erasure WHERE account_issuer = $1 AND account_subject = $2',
      [issuer, erased.id])).rows[0]!.id;

    // Backup 2 follows Account erasure and still predates scope closure and Content erasure.
    const second = await captureAndBackup('after-account', first.nativeSnapshot);
    expect(Number(second.coveredEpoch)).toBeGreaterThan(Number(first.coveredEpoch ?? '0'));
    expect(second.sourceCut).toEqual(first.sourceCut);
    expect(second.nativeSnapshot).toBe(first.nativeSnapshot);
    expect(second.backup).not.toBe(first.backup);
    expect(second.backupObjects).not.toBe(first.backupObjects);
    expect(second.authority.sealedCoverage).not.toBe(first.authority.sealedCoverage);

    // Save the exact original owner bytes before the real Main erasure for the later corruption probe.
    const originalPayload = (await contentPool.query<{ serialized_bytes: Buffer; body: object }>(
      'SELECT serialized_bytes, body FROM content.revision WHERE id = $1', [payload])).rows[0]!;
    const originalExact = await exact(contentPool, payload);
    if (originalExact.status !== 'available') throw new Error('original Content payload is unavailable');
    expect(originalExact.serializedJson).toBe(JSON.stringify({ body: payloadBody }));

    // OPS12: this Access closure is absent from backup 2. Main then admits the
    // initial Content erasure before the final authority capture.
    expect(await registry.closeScope(laterAuthorityScope, '0')).toMatchObject({ authorityEpoch: '1' });
    const main = createMainApp(fuseki, { environment: { ...workEnvironment, fuseki, lineage,
      objectDirectory: objects.directory, workObjects: objects },
      account: verifier, access: registry, erasures: new ErasureService(relay, contentPool, access) });
    const erase = async (revisionIds: string[]) => {
      const response = await main.handle(new Request('http://main.local/v1/erasures', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': `erasure-restore-${randomUUID()}` },
        body: JSON.stringify({ profile: 'content-revision-erasure-v1', actingSubject: actor,
          resourceId: work, revisionIds }) }));
      expect(response.status).toBe(200);
      return await response.json() as { erasureId: string; erasureEpoch: string };
    };
    const contentErasure = await erase([payload]);
    expect(await exact(contentPool, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(contentPool, unrelated)).toMatchObject({ status: 'available' });
    expect(await verifyErasure(relay, { content: contentPool }, contentErasure.erasureId,
      `verify:${contentErasure.erasureId}`)).toMatchObject({ state: 'reconciled' });
    const apiErasureReport = await readErasure(relay, contentErasure.erasureId);
    expect(apiErasureReport).toMatchObject({ erasureId: contentErasure.erasureId,
      erasureEpoch: contentErasure.erasureEpoch, stage: 'verified', suppression: 'suppressed' });
    expect(apiErasureReport.targets).toEqual([expect.objectContaining({ ordinal: 1,
      owner: 'content', kind: 'content_revision', ref: payload, completionState: 'completed',
      completionReasonCode: null, completionEvidenceRef: expect.stringMatching(/^[a-f0-9]{64}$/),
      completedAt: expect.any(String) })]);
    const apiErasureAdmission = (await access.query<{ state: string; graph_outcome: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string }>(
      `SELECT state, graph_outcome, graph_receipt, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [apiErasureReport.admissionId])).rows[0];
    expect(apiErasureAdmission).toMatchObject({ state: 'sealed', graph_outcome: 'succeeded',
      graph_data_epoch: ERASURE_JOURNAL_EPOCH, graph_sequence: contentErasure.erasureEpoch });
    expect(apiErasureAdmission?.graph_receipt).toMatch(/^urn:rezics:receipt:/);
    const apiErasureCut = await readSourceAfterDrain(second.consumer);
    expect(BigInt(apiErasureCut.sequence)).toBeGreaterThan(BigInt(second.sourceCut.sequence));

    // A historical active pin is admitted on a different exact target. The fourth
    // exact revision remains available for the later stale-journal injection.
    const laterExact = (await content.readExactBatch([later], async ids => new Set(ids)))[0];
    if (laterExact?.status !== 'available') throw new Error('later Content revision is unavailable');
    const laterPreparation = `erasure-restore-active-${randomUUID()}`;
    await grant(`work:read:${work}`, 'work.read');
    await grant(`content:publish:${work}`, 'content.publish');
    const laterPublication = await publishAdmittedContent(workEnvironment, content,
      verifier, registry, request, {
        preparationId: laterPreparation, revisionId: later,
        expectedDigest: laterExact.reference.byteDigest,
        expectedContentEpoch: laterSaved.position.dataEpoch,
        resourceId: work, variantId, expectedPublicationHead: null,
        actingSubject: actor, idempotencyKey: `erasure-restore-publish-${randomUUID()}` });
    if (laterPublication.status !== 'active' || !laterPublication.decision
      || !laterPublication.graphDataEpoch || !laterPublication.graphSequence) {
      throw new Error('admitted historical Content publication did not activate');
    }
    const laterNativeReceipt = laterPublication.receipt;
    const laterNativeSequence = laterPublication.graphSequence;
    const pin = (await contentPool.query<{ status: string; pin_active: boolean; graph_receipt: string;
      graph_data_epoch: string; graph_sequence: string }>(`SELECT status, pin_active, graph_receipt,
      graph_data_epoch, graph_sequence FROM content.publication_preparation WHERE operation_id = $1`,
    [laterPreparation])).rows[0];
    expect(pin).toEqual({ status: 'active', pin_active: true, graph_receipt: laterNativeReceipt,
      graph_data_epoch: laterPublication.graphDataEpoch, graph_sequence: laterNativeSequence });
    const publicationAdmission = (await access.query<{ id: string; state: string; graph_outcome: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string }>(`SELECT id, state,
      graph_outcome, graph_receipt, graph_data_epoch, graph_sequence FROM access.admission
      WHERE graph_receipt = $1`, [laterNativeReceipt])).rows[0];
    expect(publicationAdmission).toMatchObject({ state: 'sealed', graph_outcome: 'succeeded',
      graph_receipt: laterNativeReceipt, graph_data_epoch: laterPublication.graphDataEpoch,
      graph_sequence: laterNativeSequence });
    expect((await exact(contentPool, staleTarget)).status).toBe('available');

    // The erased publication makes its own Work unavailable even to an authorized
    // reader. A separate, genuinely reviewed publication proves surviving reads.
    const survivingWork = await createAdmittedMetadataWork(workEnvironment, verifier, registry, request, {
      title: 'Unrelated publication survives retained erasure', language: 'en', actingSubject: actor,
      idempotencyKey: `erasure-surviving-work-${randomUUID()}` });
    await grant(`contribution:create:${survivingWork.work}`, 'contribution.create');
    const survivingDraft = await createAdmittedTextContribution(workEnvironment, verifier, registry, request, {
      work: survivingWork.work, body: 'unrelated public text', language: 'en', actingSubject: actor,
      idempotencyKey: `erasure-surviving-draft-${randomUUID()}` });
    if (!survivingDraft.contribution || !survivingDraft.draftRevision) {
      throw new Error('surviving Contribution draft did not activate');
    }
    await grant(`contribution:read:${survivingDraft.contribution}`, 'contribution.read');
    await grant(`contribution:publish:${survivingDraft.contribution}`, 'contribution.publish');
    const survivingPublication = await publishAdmittedTextContribution(workEnvironment,
      verifier, registry, request, {
        contribution: survivingDraft.contribution, expectedDraftHead: survivingDraft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: actor, idempotencyKey: `erasure-surviving-publication-${randomUUID()}` });
    if (survivingPublication.outcome !== 'succeeded' || !survivingPublication.publicationDecision) {
      throw new Error('surviving Contribution public eligibility did not activate');
    }
    await grant(`publication:select:${survivingWork.mainVersion}`, 'publication.select');
    const survivingSelection = await selectAdmittedMainDefault(workEnvironment, verifier, registry, request, {
      context: { kind: 'main-version-default', id: survivingWork.mainVersion }, work: survivingWork.work,
      contribution: survivingDraft.contribution, publicationDecision: survivingPublication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor,
      idempotencyKey: `erasure-surviving-selection-${randomUUID()}` });
    if (survivingSelection.outcome !== 'succeeded' || !survivingSelection.selection) {
      throw new Error('surviving Main publication selection did not activate');
    }
    const surviving = { work: survivingWork.work, mainVersion: survivingWork.mainVersion,
      contribution: survivingDraft.contribution, draftRevision: survivingDraft.draftRevision,
      publicationDecision: survivingPublication.publicationDecision, selection: survivingSelection.selection };
    const survivingRead = await main.handle(new Request(
      `http://main.local/v1/works/${survivingWork.work.slice(-36)}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${await refreshOperatorToken()}` } }));
    expect(survivingRead.status).toBe(200);
    expect(await survivingRead.json()).toMatchObject({ id: survivingWork.work });
    const finalSourceCut = await readSourceAfterDrain(second.consumer);
    expect(BigInt(finalSourceCut.sequence)).toBeGreaterThan(BigInt(apiErasureCut.sequence));
    const third = await captureAndBackup('after-authority');
    expect(third.sourceCut).toEqual(finalSourceCut);
    expect(third.nativeSnapshot).not.toBe(first.nativeSnapshot);
    expect(third.sourceCut).toMatchObject({ dataEpoch: lineage.dataEpoch,
      relay: { dataEpoch: lineage.dataEpoch } });

    // The recovery fault injections use the established owner chain only after
    // the final signed authority cut. Access stays fenced against new admissions
    // while the live Account owner continues token introspection for protected reads.
    const sourceRecoveryGeneration = await engageAccessRecoveryFence(access);
    const fence = (await access.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
    expect(fence).toEqual({ open: false, generation: sourceRecoveryGeneration });
    const admissionsAtFence = (await access.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM access.admission')).rows[0]!.count;
    const ownerErasure = async (revisionId: string, label: string) => {
      const entry = await journalErasure(relay, {
        operationId: `erasure-restore-owner-${label}-${randomUUID()}`,
        requestDigest: sha256(JSON.stringify({ family: 'erasure-restore-owner-v1', label, revisionId })),
        kind: 'revision', principalId: operatorPrincipal, admissionId: randomUUID(),
        authorityEpoch: sourceRecoveryGeneration,
        targets: [{ kind: 'content_revision', ref: revisionId }],
      });
      expect(entry.replayed).toBe(false);
      await suppressGraphContentRevisions(fuseki, lineage,
        entry.erasureId, entry.erasureEpoch, [revisionId]);
      const nativeProof = await readGraphErasureProof(fuseki, lineage,
        entry.erasureId, entry.erasureEpoch, [revisionId]);
      expect(nativeProof.dataEpoch).toBe(third.sourceCut.dataEpoch);
      expect(BigInt(nativeProof.sequence)).toBeGreaterThan(BigInt(third.sourceCut.sequence));
      await applyContentErasure(contentPool, { erasureId: entry.erasureId,
        erasureEpoch: entry.erasureEpoch, resourceId: work, revisionIds: [revisionId],
        graphProof: nativeProof, preservationAccess: access });
      await markErasureSuppressed(relay, entry.erasureId);
      await recordErasureInventory(relay, entry.erasureId, { owners: ['content'],
        liveRetentionReason: 'Source Content rows and WAL remain until qualified recovery.' });
      const sourceAfterDrain = await readSourceAfterDrain(third.consumer);
      expect(sourceAfterDrain.dataEpoch).toBe(third.sourceCut.dataEpoch);
      expect(sourceAfterDrain.routingEpoch).toBe(third.sourceCut.routingEpoch);
      expect(BigInt(sourceAfterDrain.relay.sequence)).toBeGreaterThan(BigInt(third.sourceCut.relay.sequence));
      expect(await exact(contentPool, revisionId)).toMatchObject({ status: 'erased' });
      const retainedEvent = (await relay.query<{ erasure_epoch: string; native_data_epoch: string;
        native_sequence: string; receipt: string; relay_scope: string; relay_data_epoch: string;
        relay_sequence: string }>(`SELECT
          envelope->'data'->'receipt'->'systemProof'->>'erasureEpoch' AS erasure_epoch,
          envelope->'data'->'sourcePosition'->>'dataEpoch' AS native_data_epoch,
          envelope->'data'->'sourcePosition'->>'sequence' AS native_sequence,
          envelope->'data'->'receipt'->>'id' AS receipt,
          envelope->'data'->'relayPosition'->>'streamScope' AS relay_scope,
          envelope->'data'->'relayPosition'->>'dataEpoch' AS relay_data_epoch,
          envelope->'data'->'relayPosition'->>'sequence' AS relay_sequence
        FROM relay.delivered_event
        WHERE envelope->'data'->'receipt'->'systemProof'->>'erasureId' = $1`,
      [entry.erasureId])).rows;
      expect(retainedEvent).toHaveLength(1);
      const event = retainedEvent[0]!;
      expect(event).toEqual({ erasure_epoch: entry.erasureEpoch,
        native_data_epoch: nativeProof.dataEpoch, native_sequence: nativeProof.sequence,
        receipt: nativeProof.receipt, relay_scope: MAIN_RELAY_STREAM_SCOPE,
        relay_data_epoch: third.sourceCut.relay.dataEpoch,
        relay_sequence: sourceAfterDrain.relay.sequence });
      expect(entry.erasureEpoch).not.toBe(nativeProof.sequence);
      expect(entry.erasureEpoch).not.toBe(event.relay_sequence);
      expect({ datasetId: 'product', dataEpoch: event.native_data_epoch,
        sequence: event.native_sequence }).not.toEqual({ streamScope: event.relay_scope,
        dataEpoch: event.relay_data_epoch, sequence: event.relay_sequence });
      const report = await readErasure(relay, entry.erasureId);
      expect(report).toMatchObject({ erasureEpoch: entry.erasureEpoch, stage: 'reconciling',
        suppression: 'suppressed', destruction: 'retained',
        targets: [{ kind: 'content_revision', ref: revisionId }] });
      expect((await access.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM access.admission')).rows[0]!.count).toBe(admissionsAtFence);
      return { ...entry, nativeProof, retainedEvent: event };
    };
    const pinnedErasure = await ownerErasure(later, 'pinned-target');

    // The live Account owner keeps verifying the operator while restored copies stay isolated.
    const offline = (candidate: Awaited<ReturnType<typeof bindCandidate>>) => createMainApp(
      candidate.candidateGraph.fuseki, { environment: { fuseki: candidate.candidateGraph.fuseki,
        lineage: candidate.candidateGraph.lineage, objectDirectory: candidate.candidateObjects.directory,
        workObjects: candidate.candidateObjects.workObjects, receiptCustody: candidate.receiptCustody }, account: verifier,
      access: new AccessAdmissionRegistry(candidate.restored.access),
      erasures: new ErasureService(relay, candidate.restored.content, candidate.restored.access) });
    const readJournal = async (mainApp: ReturnType<typeof offline>) => {
      const token = await refreshOperatorToken();
      const request = new Request(`http://main.local/v1/erasures/${contentErasure.erasureId}`,
        { headers: { authorization: `Bearer ${token}` } });
      // A held read's 503 must come from the restore fence, not unavailable Account enforcement.
      expect(await verifier.verify(request, ['access:manage']))
        .toMatchObject({ issuer, subject: operator.id, accountScopes: expect.arrayContaining(['access:manage']) });
      return mainApp.handle(request);
    };

    return {
      runId, state, compose, recoveryKey, account, access, contentPool, relay,
      issuer, erased, operator, actor, work, laterAuthorityScope, first, second, third,
      payload, payloadBody, unrelated, later, staleTarget, laterPreparation, originalPayload,
      surviving,
      contentErasure, accountErasureId, pinnedErasure, ownerErasure, credentials, exact, bindCandidate,
      readFindings, expectFinding, expectFindingPrefix, expectCustodyFindings, expectBothHoldsClosed,
      ownerOperationFor, interruptBeforeOwnerRelease, offline, readJournal, refreshOperatorToken,
      pools, replayClusters, dispose, phase: recoveryFixture.phase,
    };
  } catch (error) {
    recordRetainedErasureFailure(error, 'scenario-setup');
    try { await dispose(); }
    catch (cleanupError) { recordRetainedErasureFailure(cleanupError, 'scenario-setup-cleanup'); }
    throw error;
  }
}

export function recordRetainedErasureFailure(error: unknown, phase: string): void {
  const exception = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
  const evidence = JSON.stringify({ phase, recordedAt: new Date().toISOString(), exception });
  console.error(evidence);
  const artifacts = process.env.REZICS_QA_ARTIFACT_DIR;
  if (artifacts) appendFileSync(join(artifacts, 'retained-erasure-exceptions.jsonl'), `${evidence}\n`, { mode: 0o600 });
}

export async function withRetainedErasureRestoreScenario(
  run: (scenario: Awaited<ReturnType<typeof createRetainedErasureRestoreScenario>>) => Promise<void>,
): Promise<void> {
  const scenario = await createRetainedErasureRestoreScenario();
  let failed = false;
  try { await run(scenario); }
  catch (error) {
    failed = true;
    recordRetainedErasureFailure(error, 'scenario');
    throw error;
  } finally {
    try { await scenario.dispose(); }
    catch (error) {
      recordRetainedErasureFailure(error, 'scenario-cleanup');
      if (!failed) throw error;
    }
  }
}
