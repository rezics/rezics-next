import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { Pool } from 'pg';
import type { StatePins } from '../operations/search-state.ts';
import {
  openRecoveryPayload,
  sealRecoveryPayload,
} from '../../services/account/src/recovery-envelope.ts';
import {
  canonicalRowText,
  ownerCatalog,
  scanOwnerTable,
} from '../../services/main/src/modules/work/pg-recovery-frontier.ts';
import {
  composeProcessEnvironment,
  readEnv,
  stackDirectory,
  type StackOptions,
} from '../dev/config.ts';
import {
  composeArgs,
  dockerEnvironment,
  projectRunning,
  root,
  volumeExists,
} from '../fixture/stack.ts';

const digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const decimal = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const nonempty = Type.String({ minLength: 1 });
const strict = { additionalProperties: false };
const row = Type.Object({ count: decimal, digest }, strict);
const pg = Type.Object(
  {
    systemIdentifier: decimal,
    flushedLsn: Type.String({ pattern: '^[0-9A-F]+/[0-9A-F]+$' }),
    walFile: Type.String({ pattern: '^[0-9A-F]{24}$' }),
  },
  strict,
);
export const databaseCoverageSchema = Type.Object(
  {
    pg,
    catalogDigest: digest,
    tables: Type.Record(Type.String(), row),
    excluded: Type.Record(Type.String(), nonempty),
  },
  strict,
);
export type DatabaseCoverage = Static<typeof databaseCoverageSchema>;
const image = Type.Object(
  { image: nonempty, id: Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }) },
  strict,
);
export const artifactNames = [
  'postgres.tar.gpg',
  'graph.tar.gpg',
  'objects.tar.gpg',
  'local-objects.tar.gpg',
  'configuration.json.gpg',
  'manifest.json.gpg',
] as const;
const graphPinsSchema = Type.Object(
  {
    imageId: Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
    stateVolume: nonempty,
    serverAssembler: nonempty,
    serverAssemblerSha256: digest,
    indexerAssemblerSha256: digest,
    fusekiJarSha256: digest,
    commandJarSha256: digest,
    moduleVersion: nonempty,
    facts: Type.Object(
      {
        tdb2Location: nonempty,
        luceneDirectory: nonempty,
        analyzer: nonempty,
        textDatasets: Type.Integer({ minimum: 1 }),
      },
      strict,
    ),
  },
  strict,
);
export const recoveryManifestSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: nonempty,
    capturedAt: nonempty,
    source: nonempty,
    lineage: Type.Object(
      { dataEpoch: nonempty, routingEpoch: nonempty, sequence: decimal },
      strict,
    ),
    fenceGeneration: decimal,
    sealedCoverage: nonempty,
    sealedDeletionSets: Type.Array(nonempty),
    owners: Type.Object(
      {
        account: databaseCoverageSchema,
        access: databaseCoverageSchema,
        content: databaseCoverageSchema,
        relay: databaseCoverageSchema,
      },
      strict,
    ),
    operations: Type.Literal('relay'),
    release: Type.Object(
      {
        digest,
        inputs: Type.Record(Type.String(), digest),
        engines: Type.Object({ postgres: image, fuseki: image, rustfs: image }, strict),
        graph: graphPinsSchema,
        javaBuild: nonempty,
        assemblers: Type.Object({ server: nonempty, indexer: nonempty }, strict),
      },
      strict,
    ),
    phases: Type.Record(Type.String(), Type.Number({ minimum: 0 })),
  },
  strict,
);
export type RecoveryManifest = Static<typeof recoveryManifestSchema>;
export const recoveryIndexSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: nonempty,
    manifestDigest: digest,
    artifacts: Type.Array(
      Type.Object(
        {
          file: Type.Union([
            Type.Literal('postgres.tar.gpg'),
            Type.Literal('graph.tar.gpg'),
            Type.Literal('objects.tar.gpg'),
            Type.Literal('local-objects.tar.gpg'),
            Type.Literal('configuration.json.gpg'),
            Type.Literal('manifest.json.gpg'),
          ]),
          sha256: digest,
          bytes: Type.Integer({ minimum: 1 }),
        },
        strict,
      ),
      { minItems: 6, maxItems: 6 },
    ),
  },
  strict,
);
export type RecoveryIndex = Static<typeof recoveryIndexSchema>;
export const recoveryFrontierSchema = Type.Object(
  { version: Type.Literal(1), id: nonempty, manifestDigest: digest, capturedAt: nonempty },
  strict,
);
export type RecoveryFrontier = Static<typeof recoveryFrontierSchema>;
export const RECOVERY_BUDGET_MS = 600_000;

export class RecoveryBudget {
  readonly started = Date.now();
  readonly phases: Record<string, number> = {};
  remaining(): number {
    const remaining = RECOVERY_BUDGET_MS - (Date.now() - this.started);
    if (remaining <= 0)
      throw new Error('Recovery exceeded its 600-second budget; serving remains held');
    return remaining;
  }
  async phase<T>(name: string, work: () => T | Promise<T>): Promise<T> {
    this.remaining();
    const at = performance.now();
    try {
      const result = await work();
      this.remaining();
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown failure';
      throw new Error(`Recovery phase ${name} failed: ${detail}; serving remains held`, { cause: error });
    } finally {
      this.phases[name] = Math.round(performance.now() - at);
    }
  }
}

/** Commands receive argv, never a shell-interpolated credential. Errors omit arguments and output. */
export function command(
  program: string,
  args: string[],
  budget: RecoveryBudget,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(program, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: Math.min(budget.remaining(), 300_000),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${program} recovery step failed (exit ${result.status}); serving remains held`,
    );
  return result.stdout.trim();
}

export async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function valueDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}
export function seal(value: unknown, key: string, kind: string): string {
  return JSON.stringify(sealRecoveryPayload(value, key, kind));
}
export function openManifest(sealed: string, key: string): RecoveryManifest {
  const manifest = openRecoveryPayload<RecoveryManifest>(sealed, key, 'ops-recovery-manifest');
  if (!Value.Check(recoveryManifestSchema, manifest))
    throw new Error('Recovery manifest is incomplete or invalid');
  return manifest;
}
export function openIndex(sealed: string, key: string): RecoveryIndex {
  const index = openRecoveryPayload<RecoveryIndex>(sealed, key, 'ops-recovery-index');
  if (
    !Value.Check(recoveryIndexSchema, index) ||
    new Set(index.artifacts.map((artifact) => artifact.file)).size !== artifactNames.length
  ) {
    throw new Error('Recovery artifact inventory is incomplete or invalid');
  }
  return index;
}
export function assertCurrentFrontier(index: RecoveryIndex, sealed: string, key: string): void {
  const frontier = openRecoveryPayload<RecoveryFrontier>(sealed, key, 'ops-recovery-frontier');
  if (
    !Value.Check(recoveryFrontierSchema, frontier) ||
    frontier.id !== index.id ||
    frontier.manifestDigest !== index.manifestDigest
  ) {
    throw new Error(
      'Recovery set is older than or differs from the independently retained current frontier',
    );
  }
}

/** O(artifact bytes), streamed once before decryption or any target mutation. */
export async function verifyArtifacts(directory: string, index: RecoveryIndex): Promise<void> {
  for (const artifact of index.artifacts) {
    const path = join(directory, artifact.file);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== artifact.bytes ||
      (await fileDigest(path)) !== artifact.sha256
    )
      throw new Error(`Recovery checksum differs: ${artifact.file}`);
  }
}

/** Catalog discovery and indexed 128-row keyset pages; memory is O(tables + one page). */
export async function captureDatabaseRows(pool: Pool): Promise<Omit<DatabaseCoverage, 'pg'>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await canonicalRowText(client);
    const catalog = await ownerCatalog(client);
    const tables: DatabaseCoverage['tables'] = {};
    for (const table of catalog.tables) tables[table.name] = await scanOwnerTable(client, table);
    await client.query('COMMIT');
    return { catalogDigest: catalog.digest, tables, excluded: { ...catalog.excluded } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The restored volume identity is checked separately against its new project. */
export function assertRestoredRuntime(
  release: RecoveryManifest['release'],
  actual: StatePins,
  javaBuild: string,
): void {
  if (
    valueDigest(actual) !== valueDigest({ ...release.graph, stateVolume: actual.stateVolume }) ||
    javaBuild !== release.javaBuild
  )
    throw new Error('Restored running assembler, JAR or Java pins differ');
}

export function assertFreshTarget(
  project: string,
  manifest: Pick<RecoveryManifest, 'source'>,
  occupied: (name: string) => boolean,
): void {
  if (
    !/^rezics-qa-[a-z0-9][a-z0-9-]{0,30}$/.test(project) ||
    project === manifest.source ||
    occupied(project)
  ) {
    throw new Error(
      'Restore target must be a new empty isolated QA project, distinct from the original',
    );
  }
}
export function targetOptions(project: string): StackOptions {
  if (!/^rezics-qa-[a-z0-9][a-z0-9-]{0,30}$/.test(project))
    throw new Error('Invalid isolated restore project');
  return { profile: 'qa', runId: project.slice('rezics-qa-'.length), persistent: true };
}
export function targetOccupied(project: string, budget: RecoveryBudget): boolean {
  const docker = dockerEnvironment();
  return (
    existsSync(stackDirectory(root, targetOptions(project))) ||
    projectRunning(project, docker) ||
    command(
      'docker',
      ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
      budget,
      docker,
    ) !== '' ||
    ['postgres_data', 'fuseki_data', 'rustfs_data'].some((kind) =>
      volumeExists(`${project}_${kind}`, docker),
    )
  );
}
export function stackContext(options: StackOptions, budget: RecoveryBudget) {
  const directory = stackDirectory(root, options);
  const saved = readEnv(join(directory, 'compose.env'));
  const apps = readEnv(join(directory, 'apps.env'));
  const project = options.profile === 'dev' ? 'rezics-dev' : `rezics-qa-${options.runId}`;
  const environment = composeProcessEnvironment(dockerEnvironment(), saved);
  return {
    directory,
    saved,
    apps,
    project,
    environment,
    compose: (args: string[]) =>
      command(
        'docker',
        composeArgs(project, join(directory, 'compose.env'), args),
        budget,
        environment,
      ),
  };
}
export function administratorUrl(saved: Record<string, string>, database: string): string {
  return `postgresql://postgres:${encodeURIComponent(saved.POSTGRES_PASSWORD!)}@127.0.0.1:${saved.POSTGRES_PORT}/${database}`;
}
export function privateStaging(): string {
  const path = join(root, '.temp', 'ops', `staging-${randomUUID()}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
export function assertSeparateCustody(set: string, frontier: string): void {
  const directory = resolve(set);
  const retained = resolve(frontier);
  if (retained === directory || retained.startsWith(`${directory}/`))
    throw new Error('Current frontier must be retained outside the recovery set');
}

/** Local stacks support regular files/directories only, never external tablespaces or link traversal. */
export function assertRegularTree(directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) assertRegularTree(path);
    else if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Recovery tree contains a link or special file');
  }
}
export async function assertSafeTar(path: string, budget: RecoveryBudget): Promise<void> {
  for (const verbose of [false, true]) {
    const child = spawn('tar', [verbose ? '-tvf' : '-tf', path], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.min(budget.remaining(), 300_000));
    let pending = '';
    const check = (line: string) => {
      if (
        verbose
          ? !/^[d-]/.test(line)
          : line.startsWith('/') || line.split('/').includes('..') || /[\\\r]/.test(line)
      ) {
        throw new Error('Recovery archive contains an unsafe path, link or special file');
      }
    };
    try {
      for await (const chunk of child.stdout!) {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop()!;
        for (const line of lines) check(line);
        if (pending.length > 16_384) throw new Error('Recovery archive path exceeds its bound');
      }
      if (pending) check(pending);
      if ((await exited) !== 0) throw new Error('Recovery archive inspection failed');
    } catch (error) {
      child.kill('SIGKILL');
      await exited.catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
