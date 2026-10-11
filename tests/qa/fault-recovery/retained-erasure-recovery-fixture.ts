import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from
  '../../../services/main/src/infrastructure/immutable-objects.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { assertObjectRecoveryCoverage, type ObjectRecoveryStore } from
  '../../../services/main/src/modules/owner/object-coverage.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce } from
  '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { retainErasureCoverage } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { captureGraphRecoveryCoverage, cutoverRestoredGraphLineage, readGraphRecoverySource,
  readRestoredGraphReleaseExpectation, RestoreLineageConflict, type RecoveryCoverage } from
  '../../../services/main/src/modules/work/restore-lineage.ts';
import { copyRecoveryTree } from '../support/recovery-copy.ts';
import { startPreparedPostgresCluster, type PostgresCluster } from '../support/postgres-cluster.ts';
import { qaStack, pinnedImage, standaloneFuseki, fusekiSecrets, type StandaloneFuseki } from
  './search-ops-support.ts';

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

export interface RetainedErasureCleanupAction {
  resource: string;
  run: () => void | Promise<void>;
}

export function createRetainedErasureCandidateDisposal(
  actions: readonly RetainedErasureCleanupAction[],
): () => Promise<void> {
  const completed = new Set<RetainedErasureCleanupAction>();
  let active: Promise<void> | undefined;
  return () => {
    if (active) return active;
    const run = async () => {
      const pending = actions.filter(action => !completed.has(action));
      const failures: Array<{ action: RetainedErasureCleanupAction; error: unknown }> = [];
      for (const action of pending) {
        try {
          await action.run();
          completed.add(action);
        } catch (error) {
          failures.push({ action, error });
        }
      }
      if (failures.length) {
        throw new AggregateError(failures.map(({ action, error }) =>
          new Error(`${action.resource} cleanup failed`, { cause: error })),
        'retained erasure candidate cleanup failed');
      }
    };
    active = run().finally(() => { active = undefined; });
    return active;
  };
}

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
  const timingPath = join(artifactDirectory, 'retained-erasure-recovery-fixture-timings.json');
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

  const subprocess = (command: string, program: string, args: string[], timeout: number): string => {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = spawnSync(program, args, { env: qa.dockerEnv, encoding: 'utf8', timeout,
      maxBuffer: 2_000_000 });
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
  const docker = (args: string[], timeout = 120_000): string =>
    subprocess(`docker ${args[0]}`, 'docker', args, timeout);
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
      appendFileSync(join(postgresDirectory, 'postgresql.auto.conf'),
        "\narchive_mode = off\nrestore_command = 'false'\n");
      writeFileSync(join(postgresDirectory, 'recovery.signal'), '');
      const cluster = await startPreparedPostgresCluster(postgresDirectory, { role: 'postgres' });
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
    const disposeCandidate = createRetainedErasureCandidateDisposal([
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
            subprocess('pg_basebackup', 'docker', ['exec', '-u', 'postgres', container, 'sh', '-ec',
              `PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -p 5432 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast --verbose --progress`],
            65_000);
            docker(['cp', `${container}:${remote}`, backupPostgres]);
            subprocess('pg_verifybackup', 'pg_verifybackup', ['--no-parse-wal', backupPostgres], 15_000);
          } finally {
            docker(['exec', '-u', 'postgres', container, 'rm', '-rf', remote], 10_000);
          }
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

  return { captureAndRestore, dispose };
}
