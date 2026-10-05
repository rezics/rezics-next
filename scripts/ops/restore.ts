import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { openRecoveryPayload } from '../../services/account/src/recovery-envelope.ts';
import {
  assertDeletionRecoverySet,
  type DeletionRecoverySet,
} from '../../services/account/src/deletion-recovery-set.ts';
import { releaseAccessRecoveryFence } from '../../services/main/src/modules/access/admission.ts';
import { assertContentRecoveryCoverage } from '../../services/main/src/modules/work/content-recovery-coverage.ts';
import { assertObjectRecoveryCoverage } from '../../services/main/src/modules/owner/object-coverage.ts';
import { assertPgRecoveryFrontier } from '../../services/main/src/modules/work/pg-recovery-frontier.ts';
import {
  cutoverRestoredGraphLineage,
  type RecoveryCoverage,
} from '../../services/main/src/modules/work/restore-lineage.ts';
import { appEnvironment, replacePrivate, savePrivate, stackDirectory } from '../dev/config.ts';
import { releaseDigest } from '../dev/release-manifest.ts';
import { currentEngines, freshPorts, root } from '../fixture/stack.ts';
import {
  assertPinnedState,
  inspectFusekiState,
  offlineTextIndex,
  repositoryPins,
} from '../operations/search-state.ts';
import { graphRunner, objectStore, releaseInputs } from './backup.ts';
import {
  administratorUrl,
  assertCurrentFrontier,
  assertFreshTarget,
  assertRegularTree,
  assertRestoredRuntime,
  assertSafeTar,
  assertSeparateCustody,
  captureDatabaseRows,
  command,
  fileDigest,
  openIndex,
  openManifest,
  privateStaging,
  RecoveryBudget,
  stackContext,
  targetOccupied,
  targetOptions,
  valueDigest,
  verifyArtifacts,
  type RecoveryManifest,
} from './recovery-set.ts';

export interface RestoredContext {
  budget: RecoveryBudget;
  manifest: RecoveryManifest;
  apps: Record<string, string>;
  appsFile: string;
  pools: Record<keyof RecoveryManifest['owners'], Pool>;
  fuseki: FusekiClient;
}
export interface RestoreChecks {
  /** Exact samples, authorized/denied reads, deleted subjects, revoked grants,
   * representative search and Account/library takeout; any failure keeps held. */
  verify(context: RestoredContext): Promise<void>;
  /** Adapter to POST /v1/owners/reconciliations on this isolated Main instance.
   * Account owns authentication; a local recovery command must not forge it. */
  reconcile(
    context: RestoredContext,
    body: {
      profile: 'owner-reconciliation-v1';
      kind: 'restore';
      sealedCoverage: string;
      sealedDeletionSets: string[];
    },
    key: string,
  ): Promise<Response>;
}
export interface RestoreOptions {
  set: string;
  project: string;
  frontier: string;
  key: string;
  environment?: NodeJS.ProcessEnv;
  checks?: RestoreChecks;
}
export interface RestoreEvidence {
  id?: string;
  project: string;
  state: 'held' | 'verified';
  phases: Record<string, number>;
  elapsedMs: number;
  budgetMs: number;
  failure?: string;
}

/** Always new volumes, never the original. O(encrypted bytes + restored owner rows
 * + referenced object bytes + indexed RDF); per-table pages and native commands
 * have bounded memory/time. Verification precedes the only hold-release API.
 * A failed pass stops all target services but preserves fenced volumes/evidence. */
export async function restoreRecoverySet(options: RestoreOptions): Promise<RestoreEvidence> {
  const budget = new RecoveryBudget();
  const environment = { ...process.env, ...options.environment };
  const directory = resolve(options.set);
  const staging = privateStaging();
  const target = targetOptions(options.project);
  const targetDirectory = stackDirectory(root, target);
  const evidence: RestoreEvidence = {
    project: options.project,
    state: 'held',
    phases: budget.phases,
    elapsedMs: 0,
    budgetMs: 600_000,
  };
  let context: ReturnType<typeof stackContext> | undefined;
  let pools: RestoredContext['pools'] | undefined;
  let created = false;
  try {
    assertSeparateCustody(directory, options.frontier);
    const index = openIndex(readFileSync(join(directory, 'set.json'), 'utf8'), options.key);
    evidence.id = index.id;
    assertCurrentFrontier(index, readFileSync(options.frontier, 'utf8'), options.key);
    await budget.phase('checksums', () => verifyArtifacts(directory, index));
    await budget.phase('decrypt', () => {
      for (const artifact of index.artifacts)
        command(
          'gpg',
          [
            '--batch',
            '--no-tty',
            '--output',
            join(staging, artifact.file.slice(0, -4)),
            '--decrypt',
            join(directory, artifact.file),
          ],
          budget,
          environment,
        );
    });
    if ((await fileDigest(join(staging, 'manifest.json'))) !== index.manifestDigest)
      throw new Error('Recovery manifest checksum differs');
    const manifest = openManifest(
      readFileSync(join(staging, 'manifest.json'), 'utf8'),
      options.key,
    );
    if (manifest.id !== index.id) throw new Error('Recovery index binds another manifest');
    assertFreshTarget(options.project, manifest, (project) => targetOccupied(project, budget));
    if (
      manifest.release.digest !== releaseDigest() ||
      valueDigest(manifest.release.inputs) !== valueDigest(await releaseInputs()) ||
      valueDigest(manifest.release.engines) !== valueDigest(currentEngines(environment))
    ) {
      throw new Error('Recovery release, schema, assembler or engine pins differ');
    }
    // A stopped source may be restarted after a backup; failover cannot serve
    // both. This check is repeated immediately before hold release.
    const sourceStopped = () => {
      if (
        command(
          'docker',
          ['ps', '-q', '--filter', `label=com.docker.compose.project=${manifest.source}`],
          budget,
          environment,
        )
      ) {
        throw new Error('Original project is running; fence it before restoring a successor');
      }
    };
    sourceStopped();
    for (const name of ['postgres', 'graph', 'objects', 'local-objects'])
      await assertSafeTar(join(staging, `${name}.tar`), budget);
    await budget.phase('configure', async () => {
      const configuration = JSON.parse(
        readFileSync(join(staging, 'configuration.json'), 'utf8'),
      ) as unknown;
      if (
        !configuration ||
        typeof configuration !== 'object' ||
        Array.isArray(configuration) ||
        Object.values(configuration).some((value) => typeof value !== 'string') ||
        'RECOVERY_MANIFEST_HMAC_KEY' in configuration
      )
        throw new Error('Encrypted stack configuration is invalid');
      const saved = {
        ...(configuration as Record<string, string>),
        ...(await freshPorts()),
        REZICS_STACK_STORAGE: 'persistent',
        REZICS_STACK_RAW_UPDATE: '0',
      };
      mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
      created = true;
      savePrivate(join(targetDirectory, 'compose.env'), saved);
      savePrivate(join(targetDirectory, 'apps.env'), appEnvironment(saved, targetDirectory));
      context = stackContext(target, budget);
    });
    await budget.phase('volumes', () => {
      for (const kind of ['postgres_data', 'fuseki_data', 'rustfs_data'])
        command('docker', ['volume', 'create', `${options.project}_${kind}`], budget, environment);
      const helper = manifest.release.engines.postgres.image;
      for (const [name, kind, location] of [
        ['postgres', 'postgres_data', '/to/18/docker'],
        ['graph', 'fuseki_data', '/to'],
        ['objects', 'rustfs_data', '/to'],
      ] as const) {
        command(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--user',
            '0:0',
            '--volume',
            `${options.project}_${kind}:/to`,
            '--volume',
            `${staging}:/backup:ro,Z`,
            '--entrypoint',
            'sh',
            helper,
            '-ec',
            `mkdir -p ${location} && tar -xf /backup/${name}.tar -C ${location}`,
          ],
          budget,
          environment,
        );
      }
      mkdirSync(join(staging, 'postgres'), { mode: 0o700 });
      command(
        'tar',
        ['-xf', join(staging, 'postgres.tar'), '-C', join(staging, 'postgres')],
        budget,
      );
      assertRegularTree(join(staging, 'postgres'));
      // Verify before modifying the copied physical backup's recovery settings.
      command(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--volume',
          `${staging}/postgres:/backup:ro,Z`,
          '--entrypoint',
          'pg_verifybackup',
          helper,
          '/backup',
        ],
        budget,
        environment,
      );
      command(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--user',
          '0:0',
          '--volume',
          `${options.project}_postgres_data:/to`,
          '--entrypoint',
          'sh',
          helper,
          '-ec',
          "printf '\narchive_mode = off\nrestore_command = '\"'\"'false'\"'\"'\n' >> /to/18/docker/postgresql.auto.conf; touch /to/18/docker/recovery.signal; mkdir -p /to/archive; chown postgres:postgres /to/archive; chown -R postgres:postgres /to/18/docker",
        ],
        budget,
        environment,
      );
      mkdirSync(context!.apps.MAIN_OBJECT_DIRECTORY!, { recursive: true, mode: 0o700 });
      command(
        'tar',
        ['-xf', join(staging, 'local-objects.tar'), '-C', context!.apps.MAIN_OBJECT_DIRECTORY!],
        budget,
      );
    });
    await budget.phase('start-held', () => {
      context!.compose(['up', '-d', '--wait', 'postgres', 'fuseki', 'rustfs']);
    });
    pools = Object.fromEntries(
      ['account', 'access', 'content', 'relay'].map((database) => [
        database,
        new Pool({ connectionString: administratorUrl(context!.saved, database), max: 4 }),
      ]),
    ) as RestoredContext['pools'];
    for (const pool of Object.values(pools))
      pool.on('error', () => {
        /* failed restore stops storage */
      });
    const restoredPools = pools;
    const coverage = openRecoveryPayload<RecoveryCoverage>(
      manifest.sealedCoverage,
      options.key,
      'graph-recovery-coverage',
    );
    const fuseki = new FusekiClient(
      context!.apps.FUSEKI_URL!,
      context!.apps.FUSEKI_MAINTENANCE_TOKEN,
      context!.apps.FUSEKI_COMMAND_TOKEN,
    );
    await budget.phase('running-pins', async () => {
      const runner = graphRunner(context!);
      const pins = await inspectFusekiState(runner, context!.environment, fuseki);
      assertPinnedState(
        pins,
        repositoryPins(root, context!.environment, `${options.project}_fuseki_data`, [
          `${manifest.source}_fuseki_data`,
        ]),
      );
      assertRestoredRuntime(manifest.release, pins, runner.exec('java -version 2>&1'));
    });
    await budget.phase('lineage-hold', async () => {
      const lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
      await cutoverRestoredGraphLineage(fuseki, { prior: manifest.lineage, next: lineage });
      const saved = {
        ...context!.saved,
        MAIN_DATA_EPOCH: lineage.dataEpoch,
        MAIN_ROUTING_EPOCH: lineage.routingEpoch,
      };
      replacePrivate(join(targetDirectory, 'compose.env'), saved);
      replacePrivate(join(targetDirectory, 'apps.env'), appEnvironment(saved, targetDirectory));
      context = stackContext(target, budget);
    });
    await budget.phase('wal-and-owner-coverage', async () => {
      for (let attempt = 0; ; attempt++) {
        const recovering = (
          await restoredPools.account.query<{ recovering: boolean }>(
            'SELECT pg_is_in_recovery() AS recovering',
          )
        ).rows[0]?.recovering;
        if (recovering === false) break;
        budget.remaining();
        if (attempt >= 100) throw new Error('PostgreSQL recovery did not promote');
        await Bun.sleep(100);
      }
      for (const name of ['account', 'access', 'content', 'relay'] as const) {
        await assertPgRecoveryFrontier(restoredPools[name], manifest.owners[name].pg);
        const actual = await captureDatabaseRows(restoredPools[name]);
        const expected = manifest.owners[name];
        if (
          valueDigest(actual) !==
          valueDigest({
            catalogDigest: expected.catalogDigest,
            tables: expected.tables,
            excluded: expected.excluded,
          })
        )
          throw new Error(`Restored ${name} owner catalog/rows differ`);
      }
      if (!coverage.content || !coverage.objects)
        throw new Error('Complete owner coverage is missing');
      await assertContentRecoveryCoverage(restoredPools.content, fuseki, coverage.content);
      await assertObjectRecoveryCoverage(
        fuseki,
        objectStore(context!.apps, budget),
        coverage.objects,
      );
      for (const sealedSet of manifest.sealedDeletionSets)
        await assertDeletionRecoverySet(
          restoredPools.account,
          restoredPools.access,
          openRecoveryPayload<DeletionRecoverySet>(sealedSet, options.key, 'deletion-recovery-set'),
        );
    });
    await budget.phase('text-rebuild', async () => {
      const log = await offlineTextIndex(graphRunner(context!));
      writeFileSync(join(targetDirectory, 'recovery-text-rebuild.log'), log, {
        mode: 0o600,
        flag: 'wx',
      });
      if (
        ((await fuseki.commandHealth()) as { textIndexUncertain?: boolean }).textIndexUncertain !==
        false
      )
        throw new Error('Rebuilt text remains uncertain');
    });
    if (!options.checks)
      throw new Error(
        'Restore is held: configure exact read/search/takeout checks and authenticated owner reconciliation',
      );
    const restored: RestoredContext = {
      budget,
      manifest,
      apps: context!.apps,
      appsFile: join(targetDirectory, 'apps.env'),
      pools: restoredPools,
      fuseki,
    };
    await budget.phase('samples-reads-search-takeout', () => options.checks!.verify(restored));
    await budget.phase('owner-reconciliation-api', async () => {
      assertCurrentFrontier(index, readFileSync(options.frontier, 'utf8'), options.key);
      sourceStopped();
      const response = await options.checks!.reconcile(
        restored,
        {
          profile: 'owner-reconciliation-v1',
          kind: 'restore',
          sealedCoverage: manifest.sealedCoverage,
          sealedDeletionSets: manifest.sealedDeletionSets,
        },
        `recovery-${manifest.id}-${options.project}`,
      );
      const body = (await response.json()) as { state?: string; disposition?: string };
      if (!response.ok || body.state !== 'reconciled' || body.disposition !== 'matched')
        throw new Error(
          `Owner reconciliation did not verify the restore (${response.status}, ${body.state ?? 'unknown'}, ${body.disposition ?? 'unknown'})`,
        );
    });
    await budget.phase('release-access', async () => {
      await restoredPools.content.query('SELECT reading_position.advance_restore_epoch()');
      await releaseAccessRecoveryFence(restoredPools.access, manifest.fenceGeneration);
      await restoredPools.account.query(
        'ALTER ROLE account LOGIN; ALTER ROLE access LOGIN; ALTER ROLE content LOGIN; ALTER ROLE relay LOGIN',
      );
    });
    evidence.state = 'verified';
    return evidence;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    if (created && context) {
      try {
        // Cleanup must still run after the operation's deadline has expired.
        stackContext(target, new RecoveryBudget()).compose(['stop']);
      } catch {
        /* durable NOLOGIN and Access/graph holds remain */
      }
    }
    throw error;
  } finally {
    await Promise.allSettled(Object.values(pools ?? {}).map((pool) => pool.end()));
    rmSync(staging, { recursive: true, force: true });
    evidence.elapsedMs = Date.now() - budget.started;
    if (created)
      writeFileSync(
        join(targetDirectory, 'recovery-evidence.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const take = (flag: string) => {
    const at = args.indexOf(flag);
    const value = args[at + 1];
    if (at < 0 || !value || value.startsWith('--')) throw new Error(`Missing ${flag}`);
    args.splice(at, 2);
    return value;
  };
  const set = take('--set');
  const project = take('--project');
  if (args.length) throw new Error('Unexpected restore arguments');
  const frontier = process.env.OPS_RECOVERY_FRONTIER;
  const key = process.env.RECOVERY_MANIFEST_HMAC_KEY ?? '';
  if (!frontier) throw new Error('OPS_RECOVERY_FRONTIER is required from independent custody');
  console.log(JSON.stringify(await restoreRecoverySet({ set, project, frontier, key })));
}
