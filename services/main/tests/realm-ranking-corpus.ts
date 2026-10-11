import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { copyRecoveryTree } from '../../../tests/qa/support/recovery-copy.ts';
import { cloneQaOwnerDatabases, type QaOwnerClones } from '../../../tests/qa/support/databases.ts';
import { readEnv, projectName, stackDirectory, type StackOptions } from '../../../scripts/dev/config.ts';
import { compatibleLoadStorage, loadCompatibility, type LoadCompatibility } from '../../../scripts/load/compatibility.ts';
import { postgresImage } from '../../../scripts/fixture/stack.ts';

const root = resolve(import.meta.dir, '../../..');
const composeFile = join(root, 'infra/dev/compose.yaml');

/** Bump when the reply recipe or the retained cuts change, not for unrelated code edits. */
export const REALM_RANKING_CORPUS_VERSION = 'realm-ranking-commands-v2';
export const REALM_RANKING_SCALES = [100, 400, 1600] as const;
export type RealmRankingScale = (typeof REALM_RANKING_SCALES)[number];
export const REALM_RANKING_FILLERS = 1_598;
export const REALM_RANKING_BUILD_RUN = 'realmrankbuild';

const owners = ['access', 'content', 'relay'] as const;

export interface RealmRankingIdentity {
  dataEpoch: string;
  routingEpoch: string;
  realm: string;
  author: string;
  reader: string;
  work: string;
  draftRevision: string;
  opening: {
    reply: string;
    revision: string;
    placement: string;
    digest: string;
    review: string;
  };
  winner: { reply: string; placement: string };
}

export interface RealmRankingCorpusManifest {
  format: 'realm-ranking-corpus-v1';
  version: string;
  compatibility: LoadCompatibility;
  preparationMs: number;
  /** Fillers posted through the Realm reply commands, after the opening and the second root. */
  fillers: number;
  identity: RealmRankingIdentity;
  scales: RealmRankingScale[];
}

export function realmRankingCorpusKey(compatibility = loadCompatibility(root)): string {
  return `realm-ranking-${createHash('sha256')
    .update(JSON.stringify([REALM_RANKING_CORPUS_VERSION, compatibility.digest]))
    .digest('hex')
    .slice(0, 16)}`;
}

export function realmRankingCorpusRoot(): string {
  return join(root, '.temp', 'realm-ranking-corpus', realmRankingCorpusKey());
}

export function realmRankingBuildCommand(): string {
  return 'bun services/main/tests/build-realm-ranking-corpus.ts';
}

/** How to produce the backup. The ranking test prints this instead of writing SQL. */
export function realmRankingCorpusInstructions(reason = 'the backup is not in this checkout'): string {
  const key = realmRankingCorpusKey();
  return `Realm ranking corpus ${REALM_RANKING_CORPUS_VERSION} (${key}) cannot be restored: ${reason}. `
    + `Build it once, outside the 600s preparation budget, with \`${realmRankingBuildCommand()}\`. `
    + `That posts ${REALM_RANKING_FILLERS} Realm replies through the product commands and retains `
    + `stopped cuts at ${REALM_RANKING_SCALES.join(', ')} root threads.`;
}

export function readRealmRankingCorpus(): RealmRankingCorpusManifest | undefined {
  const path = join(realmRankingCorpusRoot(), 'manifest.json');
  if (!existsSync(path)) return undefined;
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as RealmRankingCorpusManifest;
  if (manifest.format !== 'realm-ranking-corpus-v1' || manifest.version !== REALM_RANKING_CORPUS_VERSION
    || manifest.fillers !== REALM_RANKING_FILLERS
    || !compatibleLoadStorage(manifest.compatibility, loadCompatibility(root))
    || REALM_RANKING_SCALES.some(size => !manifest.scales.includes(size) || !cutReady(size))) {
    return undefined;
  }
  return manifest;
}

export function explainUnavailableCorpus(): string {
  const current = loadCompatibility(root);
  const directory = join(root, '.temp', 'realm-ranking-corpus');
  if (!existsSync(directory)) return realmRankingCorpusInstructions();
  const stale = readdirSync(directory).flatMap(name => {
    const path = join(directory, name, 'manifest.json');
    if (!existsSync(path)) return [];
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Partial<RealmRankingCorpusManifest>;
    if (manifest.version !== REALM_RANKING_CORPUS_VERSION) return [];
    if (compatibleLoadStorage(manifest.compatibility, current)) return [];
    return [name];
  });
  if (stale.length) {
    return realmRankingCorpusInstructions(`retained cut ${stale[0]} does not match this checkout's owner migrations and graph model`);
  }
  return realmRankingCorpusInstructions();
}

function cutDirectory(size: RealmRankingScale): string {
  return join(realmRankingCorpusRoot(), String(size));
}

function cutReady(size: RealmRankingScale): boolean {
  const directory = cutDirectory(size);
  return owners.every(owner => existsSync(join(directory, `${owner}.dump`)))
    && existsSync(join(directory, 'fuseki'));
}

export interface RealmRankingProgress {
  identity: RealmRankingIdentity;
  fillers: number;
  startedAt: number;
  /** The size-100 cut's two upvotes are already committed. A resume must not vote again. */
  voted?: boolean;
}

export function readRealmRankingProgress(): RealmRankingProgress | undefined {
  const path = join(realmRankingCorpusRoot(), 'progress.json');
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as RealmRankingProgress;
}

export function writeRealmRankingProgress(progress: RealmRankingProgress): void {
  const directory = realmRankingCorpusRoot();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'progress.json'), JSON.stringify(progress, null, 2) + '\n', { mode: 0o600 });
}

export function writeRealmRankingManifest(manifest: RealmRankingCorpusManifest): void {
  writeFileSync(join(realmRankingCorpusRoot(), 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
}

const stackOptions = (runId: string): StackOptions => ({ profile: 'qa', runId, persistent: true });

function docker(args: string[], timeout = 600_000, pipe?: { fd: number; direction: 'in' | 'out' }): string {
  const result = spawnSync('docker', args, {
    cwd: root,
    encoding: pipe ? 'utf8' : 'utf8',
    timeout,
    env: process.env,
    stdio: pipe?.direction === 'out' ? ['ignore', pipe.fd, 'pipe']
      : pipe?.direction === 'in' ? [pipe.fd, 'pipe', 'pipe'] : undefined,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr ?? ''} ${result.stdout ?? ''} ${result.error?.message ?? ''}`.trim().slice(-2000);
    throw new Error(`docker ${args.slice(0, 6).join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return `${result.stdout ?? ''}`;
}

function compose(runId: string, command: string[], timeout = 600_000): string {
  const options = stackOptions(runId);
  const envFile = join(stackDirectory(root, options), 'compose.env');
  return docker(['compose', '--env-file', envFile, '-f', composeFile, '--project-name', projectName(options), ...command], timeout);
}

function fusekiVolume(runId: string): string {
  return `${projectName(stackOptions(runId))}_fuseki_data`;
}

/** Stop Fuseki, copy its volume to a private tree, then start it again. */
export async function retainRealmRankingCut(runId: string, size: RealmRankingScale): Promise<void> {
  const destination = cutDirectory(size);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const staging = join(realmRankingCorpusRoot(), `.staging-${size}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'fuseki'), { recursive: true, mode: 0o700 });
  compose(runId, ['stop', 'fuseki'], 120_000);
  try {
    docker(['run', '--rm', '--user', '0:0', '--volume', `${fusekiVolume(runId)}:/from:ro`,
      '--volume', `${join(staging, 'fuseki')}:/to`, '--entrypoint', 'sh', postgresImage(),
      '-ec', 'cp -a /from/. /to/'], 540_000);
    copyRecoveryTree(join(staging, 'fuseki'), join(destination, 'fuseki'));
    for (const owner of owners) {
      const file = openSync(join(destination, `${owner}.dump`), 'w', 0o600);
      try {
        docker(['compose', '--env-file', join(stackDirectory(root, stackOptions(runId)), 'compose.env'),
          '-f', composeFile, '--project-name', projectName(stackOptions(runId)),
          'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-Fc', '--no-acl', owner], 600_000,
        { fd: file, direction: 'out' });
      } finally {
        closeSync(file);
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    compose(runId, ['start', 'fuseki'], 120_000);
    await waitForFuseki(runId);
  }
}

async function waitForFuseki(runId: string): Promise<void> {
  const apps = readEnv(join(stackDirectory(root, stackOptions(runId)), 'apps.env'));
  const url = apps.FUSEKI_URL;
  if (!url) throw new Error('Restored stack has no Fuseki address');
  const deadline = Date.now() + 120_000;
  let last = 'Fuseki did not accept connections';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(last);
}

export interface RealmRankingRestore {
  runId: string;
  manifest: RealmRankingCorpusManifest;
  elapsedMs: number;
  mount: (size: RealmRankingScale) => Promise<{ urls: { access: string; content: string; relay: string } }>;
  close: () => Promise<void>;
}

/**
 * Start one persistent stack and load every retained cut into its own owner
 * databases. Mounting a scale replaces the Fuseki tree, which survives stop
 * because this project is persistent, then returns that scale's SQL urls.
 * Routine callers keep the restore, startup and readiness under 600s.
 */
export async function restoreRealmRankingCorpus(): Promise<RealmRankingRestore> {
  const started = Date.now();
  const manifest = readRealmRankingCorpus();
  if (!manifest) throw new Error(explainUnavailableCorpus());
  const harness = process.env.REZICS_QA_RUN_ID;
  if (harness && /^[a-z0-9][a-z0-9-]{0,30}$/.test(harness)) {
    const container = docker(['ps', '-q', '--filter', `label=com.docker.compose.project=rezics-qa-${harness}`,
      '--filter', 'label=com.docker.compose.service=fuseki'], 30_000).trim();
    if (container) docker(['stop', container], 90_000);
  }
  const runId = `rr${createHash('sha256').update(`${Date.now()}`).digest('hex').slice(0, 8)}`;
  process.env.REZICS_FUSEKI_MEMORY_LIMIT ??= '4g';
  process.env.REZICS_POSTGRES_MEMORY_LIMIT ??= '2g';
  const up = spawnSync('bun', ['scripts/dev/cli.ts', 'stack:up', '--profile', 'qa', '--run-id', runId, '--persistent'], {
    cwd: root, encoding: 'utf8', timeout: 300_000, env: process.env,
  });
  if (up.status !== 0) throw new Error(`Realm ranking restore stack failed: ${(up.stderr || up.stdout || '').slice(-2000)}`);
  const { stageQaBootstrap } = await import('../../../scripts/qa/bootstrap.ts');
  const staged = stageQaBootstrap(stackDirectory(root, stackOptions(runId)));
  const boot = spawnSync('bun', staged.args, {
    cwd: root, encoding: 'utf8', timeout: 300_000, env: { ...process.env, ...staged.apps },
  });
  if (boot.status !== 0) {
    throw new Error(`Realm ranking restore bootstrap failed: ${(boot.stderr || boot.stdout || '').slice(-2000)}`);
  }
  const previousRun = process.env.REZICS_QA_RUN_ID;
  process.env.REZICS_QA_RUN_ID = runId;
  const clones: Partial<Record<RealmRankingScale, QaOwnerClones>> = {};
  const urls: Partial<Record<RealmRankingScale, { access: string; content: string; relay: string }>> = {};
  try {
    for (const size of REALM_RANKING_SCALES) {
      const clone = await cloneQaOwnerDatabases(runId, [...owners], 'privileged');
      clones[size] = clone;
      for (const owner of owners) {
        const dump = join(cutDirectory(size), `${owner}.dump`);
        const file = openSync(dump, 'r');
        try {
          const database = new URL(clone.urls[owner]).pathname.slice(1);
          docker(['compose', '--env-file', join(stackDirectory(root, stackOptions(runId)), 'compose.env'),
            '-f', composeFile, '--project-name', projectName(stackOptions(runId)),
            'exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '-d', database,
            '--clean', '--if-exists', '--no-acl', '--exit-on-error'], 600_000,
          { fd: file, direction: 'in' });
        } finally {
          closeSync(file);
        }
      }
      urls[size] = { access: clone.urls.access, content: clone.urls.content, relay: clone.urls.relay };
    }
  } catch (error) {
    await Promise.all(Object.values(clones).map(clone => clone?.close().catch(() => undefined)));
    process.env.REZICS_QA_RUN_ID = previousRun;
    throw error;
  }
  let mounted: RealmRankingScale | undefined;
  return {
    runId,
    manifest,
    get elapsedMs() { return Date.now() - started; },
    mount: async size => {
      const copy = join(root, '.temp', 'realm-ranking-restore', runId, String(size), 'fuseki');
      rmSync(copy, { recursive: true, force: true });
      mkdirSync(join(copy, '..'), { recursive: true });
      copyRecoveryTree(join(cutDirectory(size), 'fuseki'), copy);
      compose(runId, ['stop', 'fuseki'], 120_000);
      try {
        docker(['run', '--rm', '--user', '0:0', '--volume', `${fusekiVolume(runId)}:/to`,
          '--volume', `${copy}:/from:ro`, '--entrypoint', 'sh', postgresImage(),
          '-ec', 'find /to -mindepth 1 -delete; cp -a /from/. /to/'], 540_000);
      } finally {
        compose(runId, ['start', 'fuseki'], 120_000);
      }
      await waitForFuseki(runId);
      const apps = readEnv(join(stackDirectory(root, stackOptions(runId)), 'apps.env'));
      process.env.FUSEKI_URL = apps.FUSEKI_URL;
      process.env.MAIN_DATA_EPOCH = manifest.identity.dataEpoch;
      process.env.MAIN_ROUTING_EPOCH = manifest.identity.routingEpoch;
      process.env.ACCESS_DATABASE_URL = urls[size]!.access;
      process.env.CONTENT_DATABASE_URL = urls[size]!.content;
      process.env.ACCOUNT_RELAY_DATABASE_URL = urls[size]!.relay;
      process.env.REZICS_QA_RUN_ID = runId;
      mounted = size;
      return { urls: urls[size]! };
    },
    close: async () => {
      const errors: unknown[] = [];
      for (const clone of Object.values(clones)) {
        try { await clone?.close(); } catch (error) { errors.push(error); }
      }
      const reset = spawnSync('bun', ['scripts/dev/cli.ts', 'stack:reset', '--profile', 'qa', '--run-id', runId, '--persistent'], {
        cwd: root, encoding: 'utf8', timeout: 300_000, env: process.env,
      });
      if (reset.status !== 0) errors.push(new Error((reset.stderr || reset.stdout || 'stack reset failed').slice(-1000)));
      rmSync(join(root, '.temp', 'realm-ranking-restore', runId), { recursive: true, force: true });
      if (previousRun) process.env.REZICS_QA_RUN_ID = previousRun;
      if (mounted && errors.length) throw new AggregateError(errors, 'Realm ranking restore cleanup failed');
      if (errors.length) throw new AggregateError(errors, 'Realm ranking restore cleanup failed');
    },
  };
}
