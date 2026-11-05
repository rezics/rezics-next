import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import type { Database } from 'bun:sqlite';
import { git } from './merge.ts';

export const CHECK_RESULT_SCHEMA = 1;
export const CHECK_RESULT_TTL_MS = defaultPolicy.storage.checkResultTtlMs;
export const CHECK_RESULT_ENV = ['CI', 'DATABASE_URL', 'NODE_ENV', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'TZ'] as const;
export type CheckResult = {
  key: string;
  unit: string;
  passed: true;
  producer: string;
  host: string;
  duration: number;
  logPath: string;
  time: number;
  schemaVersion: number;
};

export function checkResultsMigration() {
  return {
    module: 'check-results',
    version: 1,
    sql: `
CREATE TABLE check_results (
  key TEXT PRIMARY KEY, unit TEXT NOT NULL, passed INTEGER NOT NULL CHECK (passed = 1),
  producer TEXT NOT NULL, host TEXT NOT NULL, duration INTEGER NOT NULL, log_path TEXT NOT NULL,
  time INTEGER NOT NULL, schema_version INTEGER NOT NULL
);
CREATE INDEX check_results_expiry ON check_results(time);`,
  };
}

const GLOBAL =
  /^(?:bun\.lock|package\.json|bunfig\.toml|tsconfig[^/]*|patches\/|scripts\/|contracts\/|specs\/|\.github\/workflows\/|\.oxlintrc|\.oxfmtrc|\.prettier|\.editorconfig|\.gitattributes|\.gitignore|AGENTS\.md|services\/(?:kernel\/scripts\/database\.ts|auth\/scripts\/database\.ts|kernel\/db\/search\/opensearch\/Dockerfile))/;
type WorkspaceManifest = { value: unknown } | { error: unknown };
type SourceProjection = {
  globalInputs: [string, string][];
  workspaceDirs: string[];
  workspaceByName: Map<unknown, string>;
  workspaceManifests: Map<string, WorkspaceManifest>;
  trees: Map<string, string>;
};
const sourceProjectionCaches = new WeakMap<ControlPolicy['storage'], Map<string, SourceProjection>>();

function readBlobs(root: string, objects: readonly string[]): string[] {
  if (!objects.length) return [];
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: `${objects.join('\n')}\n`,
    maxBuffer: defaultPolicy.merge.gitBufferBytes,
    timeout: defaultPolicy.merge.commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || 'git cat-file --batch failed');
  let offset = 0;
  return objects.map(() => {
    const endOfHeader = result.stdout.indexOf(0x0a, offset);
    const size = Number(result.stdout.toString('utf8', offset, endOfHeader).split(' ')[2]);
    const contentStart = endOfHeader + 1;
    const contentEnd = contentStart + size;
    const content = result.stdout.toString('utf8', contentStart, contentEnd);
    offset = contentEnd + 1;
    return content;
  });
}

function sourceProjection(root: string, commit: string, policy: ControlPolicy['storage']): SourceProjection {
  let cache = sourceProjectionCaches.get(policy);
  if (!cache) {
    cache = new Map();
    sourceProjectionCaches.set(policy, cache);
  }
  const cacheKey = `${root}\0${commit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const entries = git(root, 'ls-tree', '-r', '-t', '--format=%(objectname) %(objecttype) %(path)', commit)
    .split('\n')
    .flatMap((line) => {
      const objectEnd = line.indexOf(' ');
      const typeEnd = line.indexOf(' ', objectEnd + 1);
      if (objectEnd < 0 || typeEnd < 0) return [];
      return [{ object: line.slice(0, objectEnd), type: line.slice(objectEnd + 1, typeEnd), path: line.slice(typeEnd + 1) }];
    });
  const blobs = entries.filter((entry) => entry.type === 'blob');
  const globalInputs = blobs.flatMap(({ object, path }) => (GLOBAL.test(path) ? [[path, object] as [string, string]] : []));
  const manifestPaths = blobs
    .map(({ object, path }) => ({ object, path }))
    .filter(({ path }) => /^(?:(?:apps|services|packages)\/[^/]+|tools\/goal)\/package\.json$/.test(path))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const workspaceDirs = manifestPaths.map(({ path }) => path.replace(/\/package\.json$/, ''));
  const workspaceByName = new Map<unknown, string>();
  const workspaceManifests = new Map<string, WorkspaceManifest>();
  const manifests = readBlobs(root, manifestPaths.map(({ object }) => object));
  for (const [index, dir] of workspaceDirs.entries()) {
    try {
      const value: unknown = JSON.parse(manifests[index]!);
      workspaceManifests.set(dir, { value });
      workspaceByName.set((value as { name?: unknown }).name, dir);
    } catch (error) {
      workspaceManifests.set(dir, { error });
    }
  }
  const trees = new Map(entries.filter((entry) => entry.type === 'tree').map(({ object, path }) => [path, object]));
  const projection = { globalInputs, workspaceDirs, workspaceByName, workspaceManifests, trees };
  if (cache.size > policy.globalInputCacheClearAboveEntries) cache.clear();
  cache.set(cacheKey, projection);
  return projection;
}

function workspaceClosure(projection: SourceProjection, root: string, cwd: string): string[] {
  const here = relative(root, cwd).split(sep).join('/');
  const start = projection.workspaceDirs.find((dir) => here === dir || here.startsWith(`${dir}/`));
  if (!start) return [];
  const seen = new Set<string>();
  const visit = (dir: string) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const source = projection.workspaceManifests.get(dir)!;
    if ('error' in source) throw source.error;
    const manifest = source.value as Record<string, Record<string, string>>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
      for (const [name, version] of Object.entries(manifest[field] ?? {}))
        if (version.startsWith('workspace:') && projection.workspaceByName.has(name))
          visit(projection.workspaceByName.get(name)!);
  };
  visit(start);
  return [...seen].sort();
}
export function checkResultKey(input: {
  root: string;
  commit?: string;
  cwd: string;
  command: readonly string[];
  env?: NodeJS.ProcessEnv;
  policy?: ControlPolicy['storage'];
  toolchain?: Partial<{
    bun: string;
    bunRevision: string;
    os: string;
    arch: string;
    postgres: string;
    opensearch: string;
    playwright: string;
  }>;
}): { key: string; unit: string } {
  const { root, cwd, command } = input;
  const commit = input.commit ?? git(cwd, 'rev-parse', 'HEAD');
  const projection = sourceProjection(root, commit, input.policy ?? defaultPolicy.storage);
  const here = relative(root, cwd).split(sep).join('/');
  const atRoot = here === '' || here === '.';
  let unitDirs = atRoot ? ['.'] : workspaceClosure(projection, root, cwd);
  const workdir = atRoot || unitDirs.length ? undefined : here;
  if (workdir) unitDirs = ['.'];
  const unit = workdir ?? (unitDirs.join(',') || '.');
  const trees = unitDirs.map((dir) => [
    dir,
    dir === '.' ? git(root, 'rev-parse', `${commit}^{tree}`) : projection.trees.get(dir)!,
  ]);
  const env = Object.fromEntries(CHECK_RESULT_ENV.map((name) => [name, input.env?.[name] ?? '']));
  const toolchain = {
    bun: Bun.version,
    bunRevision: Bun.revision,
    os: process.platform,
    arch: process.arch,
    postgres: 'postgres:19rc1@sha256:7c70c2455c1f22cf4fbf90b16345aa4e5f4e3efd68d68f7cd6d014f529a69108',
    opensearch:
      'opensearchproject/opensearch:3.9.0@sha256:adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c',
    playwright: 'playwright@1.64.1',
    ...input.toolchain,
  };
  const value = {
    schema: CHECK_RESULT_SCHEMA,
    command: [...command],
    env,
    trees,
    global: projection.globalInputs,
    toolchain,
    workdir: here || '.',
  };
  return { key: createHash('sha256').update(JSON.stringify(value)).digest('hex'), unit };
}
export function reusableCommand(command: readonly string[]): boolean {
  const text = command.join(' ').toLowerCase();
  return (
    !/\b(?:install|generate|codegen|capabilities)\b/.test(text) &&
    !/\b(?:live|mail|payment|clock|external)\b/.test(text)
  );
}

function reusableStoredTime(time: unknown, now: number, ttlMs: number): time is number {
  return typeof time === 'number' && Number.isFinite(time) && time <= now && time >= now - ttlMs;
}

export class CheckResults {
  constructor(
    readonly db: Database,
    readonly policy: ControlPolicy['storage'] = defaultPolicy.storage,
  ) {}
  lookup(key: string, now = Date.now()): CheckResult | undefined {
    this.db.query('DELETE FROM check_results WHERE time < ?').run(now - this.policy.checkResultTtlMs);
    const row = this.db
      .query(
        `SELECT key, unit, producer, host, duration, log_path AS logPath, time, schema_version AS schemaVersion FROM check_results WHERE key=? AND schema_version=? AND time>=? AND time<=?`,
      )
      .get(key, CHECK_RESULT_SCHEMA, now - this.policy.checkResultTtlMs, now) as
      | Omit<CheckResult, 'passed'>
      | undefined;
    return row && reusableStoredTime(row.time, now, this.policy.checkResultTtlMs)
      ? { ...row, passed: true }
      : undefined;
  }
  record(result: CheckResult, now = Date.now()): void {
    if (
      !result.passed ||
      result.schemaVersion !== CHECK_RESULT_SCHEMA ||
      !reusableStoredTime(result.time, now, this.policy.checkResultTtlMs)
    )
      return;
    this.db
      .query(
        `INSERT OR REPLACE INTO check_results(key,unit,passed,producer,host,duration,log_path,time,schema_version) VALUES(?,?,1,?,?,?,?,?,?)`,
      )
      .run(
        result.key,
        result.unit,
        result.producer,
        result.host,
        result.duration,
        result.logPath,
        result.time,
        result.schemaVersion,
      );
  }
}
