import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { captureDeletionRecoverySet } from '../../services/account/src/deletion-recovery-set.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../services/main/src/infrastructure/immutable-objects.ts';
import {
  engageAccessRecoveryFence,
  releaseAccessRecoveryFence,
} from '../../services/main/src/modules/access/admission.ts';
import { captureGraphRecoveryCoverage } from '../../services/main/src/modules/work/restore-lineage.ts';
import { capturePgRecoveryFrontier } from '../../services/main/src/modules/work/pg-recovery-frontier.ts';
import { retainRecoveryCoverageHead } from '../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { parseOptions, type StackOptions } from '../dev/config.ts';
import { releaseDigest } from '../dev/release-manifest.ts';
import { migrationInventory } from '../fixture/manifest.ts';
import { currentEngines, root } from '../fixture/stack.ts';
import {
  assertPinnedState,
  inspectFusekiState,
  repositoryPins,
  type FusekiStateRunner,
} from '../operations/search-state.ts';
import {
  administratorUrl,
  artifactNames,
  assertRegularTree,
  assertSeparateCustody,
  captureDatabaseRows,
  command,
  fileDigest,
  privateStaging,
  RecoveryBudget,
  seal,
  stackContext,
  valueDigest,
  writePrivate,
  type RecoveryManifest,
  type RecoveryIndex,
} from './recovery-set.ts';

export async function releaseInputs(): Promise<Record<string, string>> {
  const files = [
    'infra/jena/Dockerfile',
    'infra/jena/fuseki-text.ttl',
    'infra/jena/fuseki-text-qa.ttl',
    'infra/jena/fuseki-text-qa-raw.ttl',
    'services/account/src/auth.ts',
  ];
  return {
    ...migrationInventory(root),
    ...Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [file, await fileDigest(join(root, file))] as const),
      ),
    ),
  };
}
export function objectStore(apps: Record<string, string>, budget?: RecoveryBudget) {
  // Share one command deadline, rather than allocating a timer per object.
  const signal = budget ? AbortSignal.timeout(budget.remaining()) : undefined;
  const store = (prefix: string) =>
    new S3ImmutableObjects({
      endpoint: apps.MAIN_S3_ENDPOINT!,
      bucket: apps.MAIN_S3_BUCKET!,
      region: apps.MAIN_S3_REGION!,
      accessKeyId: apps.MAIN_S3_ACCESS_KEY!,
      secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
      prefix,
      ...(budget
        ? {
            readSignal: () => {
              budget.remaining();
              return signal!;
            },
          }
        : {}),
    });
  return {
    directory: apps.MAIN_OBJECT_DIRECTORY!,
    workObjects: store('semantic/work/'),
    structureObjects: store('semantic/structure/'),
    readConcurrency: 32,
  };
}

export function graphRunner(context: ReturnType<typeof stackContext>): FusekiStateRunner {
  return {
    exec: (script) => context.compose(['exec', '-T', 'fuseki', 'sh', '-ec', script]),
    offline: (script) =>
      context.compose([
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'sh',
        'fuseki',
        '-ec',
        script,
      ]),
    stop: () => {
      context.compose(['stop', 'fuseki']);
    },
    start: () => context.startup(() => {
      context.compose(['up', '-d', '--wait', 'fuseki']);
    }, { services: ['fuseki'] }),
    container: () => context.compose(['ps', '-q', 'fuseki']),
  };
}

async function assertServicesStopped(apps: Record<string, string>): Promise<void> {
  for (const url of [apps.MAIN_ORIGIN, apps.ACCOUNT_JWKS_URL]) {
    if (!url) throw new Error('Writer endpoint is missing');
    let reached = false;
    try {
      await fetch(url, { signal: AbortSignal.timeout(800), redirect: 'manual' });
      reached = true;
    } catch {
      /* no product process listening; SQL admission is fenced below */
    }
    if (reached)
      throw new Error('Stop Main, Account, relay and outbound workers before recovery capture');
  }
}

export interface BackupOptions {
  out: string;
  recipient: string;
  frontier: string;
  key: string;
  source: StackOptions;
  environment?: NodeJS.ProcessEnv;
}

/** One maintenance cut. Work is O(owner rows + graph references + volume bytes).
 * PostgreSQL roles are fenced before terminating their sessions; Access admission
 * drains before coverage, and no live TDB2/object volume is copied. A failure
 * releases only its own fences before publication so capture can be retried.
 * A failure after publication keeps storage stopped and retains any hold. */
export async function backupRecoverySet(
  options: BackupOptions,
): Promise<{ index: RecoveryIndex; phases: Record<string, number> }> {
  const budget = new RecoveryBudget();
  const out = resolve(options.out);
  const environment = { ...process.env, ...options.environment };
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(options.recipient))
    throw new Error('Use the full off-host recipient fingerprint');
  if (!/^[0-9a-f]{64}$/i.test(options.key))
    throw new Error('RECOVERY_MANIFEST_HMAC_KEY must be 32 bytes in hex');
  assertSeparateCustody(out, options.frontier);
  if (existsSync(out)) throw new Error('Recovery output already exists');
  const context = stackContext(options.source, budget);
  if (
    context.saved.REZICS_STACK_STORAGE !== 'persistent' ||
    context.saved.REZICS_STACK_RAW_UPDATE === '1'
  ) {
    throw new Error('Recovery requires a persistent stack with raw updates disabled');
  }
  await assertServicesStopped(context.apps);
  const keys = command(
    'gpg',
    ['--batch', '--with-colons', '--list-keys', options.recipient],
    budget,
    environment,
  );
  if (!keys.includes(`:${options.recipient.toUpperCase()}:`))
    throw new Error('Recipient public key is unavailable');
  // Encryption hosts must not retain the recovery private key.
  if (
    command(
      'gpg',
      ['--batch', '--with-colons', '--list-secret-keys'],
      budget,
      environment,
    ).includes(`:${options.recipient.toUpperCase()}:`)
  )
    throw new Error('Recipient private key must live off-host');
  const staging = privateStaging();
  const pools = Object.fromEntries(
    ['account', 'access', 'content', 'relay'].map((database) => [
      database,
      new Pool({ connectionString: administratorUrl(context.saved, database), max: 2 }),
    ]),
  ) as Record<keyof RecoveryManifest['owners'], Pool>;
  for (const pool of Object.values(pools))
    pool.on('error', () => {
      /* stopped source drops idle sockets */
    });
  const id = randomUUID();
  const remote = `/tmp/rezics-recovery-${id}`;
  let held = false;
  let complete = false;
  let sourceReleased = false;
  let generation: string | undefined;
  try {
    const engines = currentEngines(context.environment);
    for (const service of ['postgres', 'fuseki', 'rustfs'] as const) {
      const container = context.compose(['ps', '-q', service]);
      if (
        !container ||
        command(
          'docker',
          ['inspect', container, '--format', '{{.Image}}'],
          budget,
          context.environment,
        ) !== engines[service].id
      ) {
        throw new Error('Running recovery engine differs from pinned release');
      }
    }
    const fuseki = new FusekiClient(
      context.apps.FUSEKI_URL!,
      context.apps.FUSEKI_MAINTENANCE_TOKEN,
      context.apps.FUSEKI_COMMAND_TOKEN,
    );
    const runner = graphRunner(context);
    const graph = await budget.phase('running-pins', async () => {
      const pins = await inspectFusekiState(runner, context.environment, fuseki);
      assertPinnedState(
        pins,
        repositoryPins(root, context.environment, `${context.project}_fuseki_data`),
      );
      return pins;
    });
    const javaBuild = runner.exec('java -version 2>&1');
    for (const [name, path] of [
      ['server', graph.serverAssembler],
      ['indexer', '/fuseki/fuseki-text.ttl'],
    ] as const) {
      command(
        'docker',
        ['cp', `${runner.container()}:${path}`, join(staging, `${name}.ttl`)],
        budget,
        context.environment,
      );
    }
    const assemblers = {
      server: readFileSync(join(staging, 'server.ttl'), 'utf8'),
      indexer: readFileSync(join(staging, 'indexer.ttl'), 'utf8'),
    };
    await budget.phase('fence', async () => {
      const existing = (
        await pools.access.query<{ open: boolean }>(
          'SELECT open FROM access.recovery_fence WHERE id = true',
        )
      ).rows[0];
      if (existing?.open !== true)
        throw new Error('Source already has a recovery hold; do not replace or release it');
      const roles = await pools.account.query<{ rolname: string; rolcanlogin: boolean }>(
        "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('account','access','content','relay')",
      );
      if (roles.rows.length !== 4 || roles.rows.some((role) => !role.rolcanlogin))
        throw new Error('Source owner roles are already fenced');
      // ROLE NOLOGIN prevents pools and workers from reconnecting after termination.
      await pools.account.query(
        'ALTER ROLE account NOLOGIN; ALTER ROLE access NOLOGIN; ALTER ROLE content NOLOGIN; ALTER ROLE relay NOLOGIN',
      );
      held = true;
      // Let already dispatched owner transactions finish; terminate only idle
      // sessions once all active work has drained, then hold new admission.
      for (;;) {
        const active = await pools.account.query(
          "SELECT 1 FROM pg_stat_activity WHERE usename IN ('account','access','content','relay') AND state <> 'idle' LIMIT 1",
        );
        if (!active.rowCount) break;
        budget.remaining();
        await Bun.sleep(100);
      }
      await pools.account.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename IN ('account','access','content','relay')",
      );
      generation = await engageAccessRecoveryFence(pools.access);
      if (
        (await pools.access.query("SELECT 1 FROM access.admission WHERE state <> 'sealed' LIMIT 1"))
          .rowCount
      ) {
        throw new Error('Source has unresolved admissions; reconcile receipts before capture');
      }
    });
    if (!generation) throw new Error('Source recovery fence generation is unavailable');
    const capturedGeneration = generation;
    const coverage = await budget.phase('coverage', () =>
      captureGraphRecoveryCoverage(
        fuseki,
        pools.account,
        pools.access,
        pools.relay,
        context.apps.MAIN_RELAY_CONSUMER!,
        pools.content,
        objectStore(context.apps, budget),
      ),
    );
    const sealedCoverage = seal(coverage, options.key, 'graph-recovery-coverage');
    await retainRecoveryCoverageHead(pools.relay, sealedCoverage, options.key);
    const deletions = await pools.access.query<{ account_issuer: string; account_subject: string }>(
      `SELECT p.account_issuer, p.account_subject FROM access.principal p JOIN access.outbox o
       ON o.principal_id = p.id WHERE o.kind = 'account.deletion_fenced' ORDER BY p.id`,
    );
    const sealedDeletionSets: string[] = [];
    for (const deletion of deletions.rows)
      sealedDeletionSets.push(
        seal(
          await captureDeletionRecoverySet(
            pools.account,
            pools.access,
            deletion.account_issuer,
            deletion.account_subject,
          ),
          options.key,
          'deletion-recovery-set',
        ),
      );
    // Freeze graph/object bytes immediately after coverage; keep only the
    // fenced PostgreSQL cluster running for its physical base/WAL capture.
    context.compose(['stop', 'fuseki', 'rustfs']);
    const owners = {} as RecoveryManifest['owners'];
    await budget.phase('owner-catalogs', async () => {
      for (const name of ['account', 'access', 'content', 'relay'] as const)
        owners[name] = {
          pg: await capturePgRecoveryFrontier(pools[name]),
          ...(await captureDatabaseRows(pools[name])),
        };
      const databases = await pools.account.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname",
      );
      if (
        valueDigest(databases.rows.map((row) => row.datname)) !==
        valueDigest(['access', 'account', 'content', 'relay'])
      ) {
        throw new Error('Recovery database discovery found an undeclared owner');
      }
      const defaultDatabase = new Pool({
        connectionString: administratorUrl(context.saved, 'postgres'),
        max: 1,
      });
      try {
        const defaultRows = await captureDatabaseRows(defaultDatabase);
        if (Object.keys(defaultRows.tables).length || Object.keys(defaultRows.excluded).length) {
          throw new Error('Recovery discovered owner tables in the undeclared default database');
        }
      } finally {
        await defaultDatabase.end();
      }
    });
    await budget.phase('postgres-base-and-wal', async () => {
      context.compose([
        'exec',
        '-T',
        '-u',
        'postgres',
        'postgres',
        'sh',
        '-ec',
        `PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast && pg_verifybackup ${remote}`,
      ]);
      const container = context.compose(['ps', '-q', 'postgres']);
      command(
        'docker',
        ['cp', `${container}:${remote}`, join(staging, 'postgres')],
        budget,
        context.environment,
      );
      context.compose(['exec', '-T', '-u', 'postgres', 'postgres', 'rm', '-rf', remote]);
      assertRegularTree(join(staging, 'postgres'));
      command(
        'tar',
        ['-cf', join(staging, 'postgres.tar'), '-C', join(staging, 'postgres'), '.'],
        budget,
      );
    });
    await budget.phase('stop-and-copy', () => {
      // No role may mutate any owner while the physical cluster backup runs.
      context.compose(['stop']);
      for (const [artifact, kind] of [
        ['graph', 'fuseki_data'],
        ['objects', 'rustfs_data'],
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
            `${context.project}_${kind}:/from:ro`,
            '--volume',
            `${staging}:/backup:Z`,
            '--entrypoint',
            'sh',
            engines.postgres.image,
            '-ec',
            `tar -cf /backup/${artifact}.tar -C /from .`,
          ],
          budget,
          context.environment,
        );
      }
      mkdirSync(join(staging, 'local-objects'), { mode: 0o700 });
      if (existsSync(context.apps.MAIN_OBJECT_DIRECTORY!)) {
        assertRegularTree(context.apps.MAIN_OBJECT_DIRECTORY!);
        cpSync(context.apps.MAIN_OBJECT_DIRECTORY!, join(staging, 'local-objects'), {
          recursive: true,
        });
      }
      command(
        'tar',
        ['-cf', join(staging, 'local-objects.tar'), '-C', join(staging, 'local-objects'), '.'],
        budget,
      );
      if (
        'RECOVERY_MANIFEST_HMAC_KEY' in context.saved ||
        Object.values(context.saved).some(
          (value) => value.toLowerCase() === options.key.toLowerCase(),
        )
      )
        throw new Error('Recovery HMAC key must be outside stack configuration');
      writePrivate(join(staging, 'configuration.json'), context.saved);
    });
    const manifest: RecoveryManifest = {
      version: 1,
      id,
      source: context.project,
      capturedAt: new Date().toISOString(),
      lineage: {
        dataEpoch: coverage.priorDataEpoch,
        routingEpoch: context.apps.MAIN_ROUTING_EPOCH!,
        sequence: coverage.priorSequence,
      },
      fenceGeneration: capturedGeneration,
      sealedCoverage,
      sealedDeletionSets,
      owners,
      operations: 'relay',
      release: {
        digest: releaseDigest(),
        inputs: await releaseInputs(),
        engines,
        graph,
        javaBuild,
        assemblers,
      },
      phases: budget.phases,
    };
    writeFileSync(
      join(staging, 'manifest.json'),
      seal(manifest, options.key, 'ops-recovery-manifest'),
      { mode: 0o600, flag: 'wx' },
    );
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const index: RecoveryIndex = {
      version: 1,
      id,
      manifestDigest: await fileDigest(join(staging, 'manifest.json')),
      artifacts: [],
    };
    await budget.phase('encrypt', async () => {
      for (const file of artifactNames) {
        command(
          'gpg',
          [
            '--batch',
            '--no-tty',
            '--trust-model',
            'always',
            '--recipient',
            options.recipient,
            '--output',
            join(out, file),
            '--encrypt',
            join(staging, file.slice(0, -4)),
          ],
          budget,
          environment,
        );
        index.artifacts.push({
          file,
          sha256: await fileDigest(join(out, file)),
          bytes: statSync(join(out, file)).size,
        });
      }
    });
    writeFileSync(join(out, 'set.json'), seal(index, options.key, 'ops-recovery-index'), {
      mode: 0o600,
      flag: 'wx',
    });
    // The external retained frontier is atomically replaced only after every
    // encrypted artifact and its authenticated checksum are complete.
    mkdirSync(dirname(resolve(options.frontier)), { recursive: true, mode: 0o700 });
    const frontier = `${resolve(options.frontier)}.${id}.next`;
    writeFileSync(
      frontier,
      seal(
        { version: 1, id, manifestDigest: index.manifestDigest, capturedAt: manifest.capturedAt },
        options.key,
        'ops-recovery-frontier',
      ),
      { mode: 0o600, flag: 'wx' },
    );
    renameSync(frontier, resolve(options.frontier));
    complete = true;
    await budget.phase('source-fence-release', async () => {
      // Only PostgreSQL is briefly started to release the SOURCE fence. Product
      // processes and graph/object storage stay stopped throughout.
      context.compose(['up', '-d', '--wait', 'postgres']);
      await releaseAccessRecoveryFence(pools.access, capturedGeneration);
      await pools.account.query(
        'ALTER ROLE account LOGIN; ALTER ROLE access LOGIN; ALTER ROLE content LOGIN; ALTER ROLE relay LOGIN',
      );
      context.compose(['stop', 'postgres']);
      sourceReleased = true;
    });
    writePrivate(join(out, 'backup-evidence.json'), {
      id,
      phases: budget.phases,
      elapsedMs: Date.now() - budget.started,
      budgetMs: 600_000,
    });
    return { index, phases: budget.phases };
  } finally {
    await Promise.allSettled(Object.values(pools).map((pool) => pool.end()));
    try {
      if (held && !sourceReleased) {
        // Cleanup has its own deadline: exhausting the capture budget must not
        // prevent release of an unpublished cut. Never reopen an inherited hold.
        const cleanup = stackContext(options.source, new RecoveryBudget());
        if (!complete) {
          const account = new Pool({
            connectionString: administratorUrl(context.saved, 'account'),
            max: 1,
          });
          const access = new Pool({
            connectionString: administratorUrl(context.saved, 'access'),
            max: 1,
          });
          for (const pool of [account, access]) pool.on('error', () => {});
          try {
            cleanup.compose(['up', '-d', '--wait', 'postgres']);
            if (generation) await releaseAccessRecoveryFence(access, generation);
            await account.query(
              'ALTER ROLE account LOGIN; ALTER ROLE access LOGIN; ALTER ROLE content LOGIN; ALTER ROLE relay LOGIN',
            );
            // Restore the storage precondition for an immediate retry. Main,
            // Account and all worker processes remain in their maintenance stop.
            cleanup.compose(['up', '-d', '--wait', 'postgres', 'fuseki', 'rustfs']);
          } catch {
            try {
              cleanup.compose(['stop']);
            } catch {
              /* retain cleanup failure */
            }
            throw new Error(
              'Failed backup cleanup did not complete; inspect source recovery state before resuming product processes',
            );
          } finally {
            await Promise.allSettled([account.end(), access.end()]);
          }
        } else {
          try {
            cleanup.compose(['stop']);
          } catch {
            /* keep the published cut and durable fences */
          }
        }
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
      if (!complete) rmSync(out, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const take = (flag: string) => {
    const at = args.indexOf(flag);
    if (at < 0) throw new Error(`Missing ${flag}`);
    const value = args[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing ${flag} value`);
    args.splice(at, 2);
    return value;
  };
  const out = take('--out');
  const recipient = take('--recipient');
  const key = process.env.RECOVERY_MANIFEST_HMAC_KEY ?? '';
  const frontier = process.env.OPS_RECOVERY_FRONTIER;
  if (!frontier)
    throw new Error(
      'OPS_RECOVERY_FRONTIER must name independently retained current-frontier custody',
    );
  console.log(
    JSON.stringify(
      await backupRecoverySet({ out, recipient, key, frontier, source: parseOptions(args) }),
    ),
  );
}
