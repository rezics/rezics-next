import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import type { Database } from 'bun:sqlite';
import { git } from './merge.ts';

export const CHECK_RESULT_SCHEMA = 1;
export const CHECK_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CHECK_RESULT_ENV = ['CI', 'DATABASE_URL', 'NODE_ENV', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'TZ'] as const;
export type CheckResult = {
  key: string; unit: string; passed: true; producer: string; host: string; duration: number;
  logPath: string; time: number; schemaVersion: number;
};

export function checkResultsMigration() {
  return { module: 'check-results', version: 1, sql: `
CREATE TABLE check_results (
  key TEXT PRIMARY KEY, unit TEXT NOT NULL, passed INTEGER NOT NULL CHECK (passed = 1),
  producer TEXT NOT NULL, host TEXT NOT NULL, duration INTEGER NOT NULL, log_path TEXT NOT NULL,
  time INTEGER NOT NULL, schema_version INTEGER NOT NULL
);
CREATE INDEX check_results_expiry ON check_results(time);` };
}

const GLOBAL = /^(?:bun\.lock|package\.json|bunfig\.toml|tsconfig[^/]*|patches\/|scripts\/|contracts\/|specs\/|\.github\/workflows\/|\.oxlintrc|\.oxfmtrc|\.prettier|\.editorconfig|\.gitattributes|\.gitignore|AGENTS\.md|services\/(?:kernel\/scripts\/database\.ts|auth\/scripts\/database\.ts|kernel\/db\/search\/opensearch\/Dockerfile))/;
const globalInputCache = new Map<string, [string, string][]>();
function globalInputs(root: string, commit: string): [string, string][] {
  const cacheKey = `${root}\0${commit}`;
  const cached = globalInputCache.get(cacheKey);
  if (cached) return cached;
  const inputs = git(root, 'ls-tree', '-r', '--format=%(objectname) %(path)', commit).split('\n')
    .flatMap(line => {
      const split = line.indexOf(' ');
      if (split < 0) return [];
      const object = line.slice(0, split), path = line.slice(split + 1);
      return GLOBAL.test(path) ? [[path, object] as [string, string]] : [];
    });
  if (globalInputCache.size > 64) globalInputCache.clear();
  globalInputCache.set(cacheKey, inputs);
  return inputs;
}
function workspaceClosure(root: string, cwd: string, commit: string): string[] {
  const here = relative(root, cwd).split(sep).join('/');
  const dirs = git(root, 'ls-tree', '-r', '--name-only', commit).split('\n')
    .filter(path => /^(?:apps|services|packages)\/[^/]+\/package\.json$/.test(path))
    .map(path => path.replace(/\/package\.json$/, '')).sort();
  const byName = new Map<string, string>();
  for (const dir of dirs) {
    try { byName.set(JSON.parse(git(root, 'show', `${commit}:${dir}/package.json`)).name, dir); } catch {}
  }
  const start = dirs.find(dir => here === dir || here.startsWith(`${dir}/`));
  if (!start) return dirs.length ? [] : [];
  const seen = new Set<string>();
  const visit = (dir: string) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const manifest = JSON.parse(git(root, 'show', `${commit}:${dir}/package.json`)) as Record<string, Record<string, string>>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
      for (const [name, version] of Object.entries(manifest[field] ?? {}))
        if (version.startsWith('workspace:') && byName.has(name)) visit(byName.get(name)!);
  };
  visit(start);
  return [...seen].sort();
}
export function checkResultKey(input: {
  root: string; commit?: string; cwd: string; command: readonly string[]; env?: NodeJS.ProcessEnv;
  toolchain?: Partial<{ bun: string; bunRevision: string; os: string; arch: string; postgres: string; opensearch: string; playwright: string }>;
}): { key: string; unit: string } {
  const { root, cwd, command } = input;
  const commit = input.commit ?? git(cwd, 'rev-parse', 'HEAD');
  const unitDirs = relative(root, cwd) === '' ? ['.'] : workspaceClosure(root, cwd, commit);
  const unit = unitDirs.join(',') || '.';
  const trees = unitDirs.map(dir => [dir, git(root, 'rev-parse', dir === '.' ? `${commit}^{tree}` : `${commit}:${dir}`)]);
  const env = Object.fromEntries(CHECK_RESULT_ENV.map(name => [name, input.env?.[name] ?? '']));
  const toolchain = {
    bun: Bun.version,
    bunRevision: Bun.revision,
    os: process.platform, arch: process.arch,
    postgres: 'postgres:19rc1@sha256:7c70c2455c1f22cf4fbf90b16345aa4e5f4e3efd68d68f7cd6d014f529a69108',
    opensearch: 'opensearchproject/opensearch:3.9.0@sha256:adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c',
    playwright: 'playwright@1.64.1',
    ...input.toolchain,
  };
  const value = { schema: CHECK_RESULT_SCHEMA, command: [...command], env, trees, global: globalInputs(root, commit), toolchain };
  return { key: createHash('sha256').update(JSON.stringify(value)).digest('hex'), unit };
}
export function reusableCommand(command: readonly string[]): boolean {
  const text = command.join(' ').toLowerCase();
  return !/\b(?:install|generate|codegen|capabilities)\b/.test(text) &&
    !/\b(?:live|mail|payment|clock|external)\b/.test(text);
}

export class CheckResults {
  constructor(readonly db: Database) {}
  lookup(key: string, now = Date.now()): CheckResult | undefined {
    this.db.query('DELETE FROM check_results WHERE time < ?').run(now - CHECK_RESULT_TTL_MS);
    const row = this.db.query(`SELECT key, unit, producer, host, duration, log_path AS logPath, time, schema_version AS schemaVersion FROM check_results WHERE key=? AND time>=?`)
      .get(key, now - CHECK_RESULT_TTL_MS) as Omit<CheckResult, 'passed'> | undefined;
    return row ? { ...row, passed: true } : undefined;
  }
  record(result: CheckResult): void {
    if (!result.passed || result.schemaVersion !== CHECK_RESULT_SCHEMA) return;
    this.db.query(`INSERT OR REPLACE INTO check_results(key,unit,passed,producer,host,duration,log_path,time,schema_version) VALUES(?,?,1,?,?,?,?,?,?)`)
      .run(result.key, result.unit, result.producer, result.host, result.duration, result.logPath, result.time, result.schemaVersion);
  }
}
