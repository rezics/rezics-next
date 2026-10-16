import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { cancelTrainReservation, reserveMergeTrain, runMergeTrain, trainEvent } from './merge-train.ts';
import { processAlive, processIdentity, type ProcessIdentity } from '../qa/process/identity.ts';
import { tryAcquireDirectoryLease } from '../qa/process/lease.ts';

interface ManagerCommit {
  id: string;
  base: string;
  source: string;
  paths: string[];
  goal: string;
  message: string;
  queuedAt: string;
  status: 'capturing' | 'queued' | 'running' | 'landed' | 'failed';
  owner?: ProcessIdentity;
  cleared?: boolean;
  after?: string;
  error?: string;
}

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', args, { cwd: repo, env: env ? { ...process.env, ...env } : undefined, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function save(path: string, record: ManagerCommit): void {
  writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(record)}\n`);
  renameSync(`${path}.${process.pid}.tmp`, path);
}

/** Idempotent after interruption. Never restore over an edit made after the snapshot. */
function clearCapturedEdits(repo: string, record: ManagerCommit): void {
  const entry = (tree: string, file: string) => {
    const line = git(repo, ['ls-tree', tree, '--', file]);
    return line ? line.split(/\s+/).filter((_, index) => index === 0 || index === 2).join(' ') : undefined;
  };
  const captured: string[] = [];
  for (const file of record.paths) {
    const stat = lstatSync(join(repo, file), { throwIfNoEntry: false });
    let current: string | undefined;
    if (stat?.isSymbolicLink()) {
      const blob = spawnSync('git', ['hash-object', '--stdin'], { cwd: repo, encoding: 'utf8', input: readlinkSync(join(repo, file)) });
      if (blob.status !== 0) throw new Error(blob.stderr);
      current = `120000 ${blob.stdout.trim()}`;
    } else if (stat?.isFile()) current = `${stat.mode & 0o111 ? '100755' : '100644'} ${git(repo, ['hash-object', `--path=${file}`, '--', file])}`;
    else if (stat) throw new Error(`${file} is not a file or symlink`);
    const source = entry(record.source, file);
    const base = entry(record.base, file);
    if (current === source) captured.push(file);
    else if (current !== base) throw new Error(`${file} changed after the manager snapshot; preserve the edit and resolve ${record.id}`);
  }
  // Verify every path first, so an interrupted capture can resume without clearing a later edit.
  git(repo, ['reset', '-q', record.base, '--', ...record.paths]);
  for (const file of captured) {
    if (entry(record.base, file)) git(repo, ['restore', '--source', record.base, '--worktree', '--', file]);
    else rmSync(join(repo, file), { force: true });
  }
}

/** Snapshot only the named paths with a private index. Main and a peer's staged changes stay put.
 * The caller serializes this capture with other main writers (the ledger lock). */
export function queueManagerCommit(repo: string, directory: string, paths: readonly string[], message: string,
  goal = process.env.GOAL_ID ?? 'program'): string | undefined {
  if (!paths.length) return;
  if (git(repo, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Manager commits require main');
  const selected = paths.map(path => relative(repo, resolve(repo, path)));
  if (selected.some(path => !path || path === '..' || path.startsWith('../') || path === '.git' || path.startsWith('.git/')))
    throw new Error('Manager commit paths must be files inside the checkout');
  const id = `manager-${randomUUID()}`;
  const pending = join(directory, 'manager-commits');
  mkdirSync(pending, { recursive: true });
  const index = join(pending, `${id}.index`);
  const env = { GIT_INDEX_FILE: index };
  const base = git(repo, ['rev-parse', 'main']);
  try {
    git(repo, ['read-tree', base], env);
    git(repo, ['add', '-A', '--', ...selected], env);
    const tree = git(repo, ['write-tree'], env);
    if (tree === git(repo, ['rev-parse', `${base}^{tree}`])) return;
    const source = git(repo, ['commit-tree', tree, '-p', base, '-m', message]);
    const changed = git(repo, ['diff', '--name-only', '--no-renames', '-z', base, source]).split('\0').filter(Boolean);
    // Keep the snapshot reachable even if settlement has not started when Git runs maintenance.
    git(repo, ['update-ref', `refs/goal-manager/${id}`, source]);
    const record: ManagerCommit = { id, base, source, paths: changed, message, goal,
      queuedAt: new Date().toISOString(), status: 'capturing' };
    const path = join(pending, `${id}.json`);
    save(path, record);
    reserveMergeTrain(directory, id, record.queuedAt);
    // Move the captured edit out of main's worktree before another entry lands. Selected
    // files belong to this commit; the private index left every other staged path alone.
    try { clearCapturedEdits(repo, record); }
    catch (error) {
      record.status = 'failed';
      record.error = String(error);
      save(path, record);
      cancelTrainReservation(directory, id);
      throw error;
    }
    record.status = 'queued';
    record.cleared = true;
    save(path, record);
    return id;
  } finally { rmSync(index, { force: true }); }
}

export async function runManagerCommit(repo: string, directory: string, id: string, retry = false): Promise<void> {
  if (!/^manager-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid manager commit ID');
  const path = join(directory, 'manager-commits', `${id}.json`);
  const started = Date.now();
  const timing = { id, token: `pid:${process.pid}`, lock: 'manager snapshot' };
  let waited = false;
  let lease;
  while ((lease = tryAcquireDirectoryLease(`${path}.lock`)) === 'held') {
    if (!waited) trainEvent(directory, { ...timing, event: 'lock-wait-start' });
    waited = true;
    await Bun.sleep(100);
  }
  if (waited) trainEvent(directory, { ...timing, event: 'lock-wait-end', seconds: (Date.now() - started) / 1000 });
  const record = JSON.parse(readFileSync(path, 'utf8')) as ManagerCommit;
  if (process.env.GOAL_ID && process.env.GOAL_ID !== record.goal) {
    lease.release();
    throw new Error(`${id} belongs to Goal ${record.goal}`);
  }
  if (record.status === 'landed') { lease.release(); return; }
  if (record.status === 'failed' && !retry) { lease.release(); throw new Error(record.error ?? `${id} failed`); }
  const worktree = join(directory, 'manager-trees', id);
  const branch = `train/${id}`;
  try {
    const { withLedger, retryGitIndexLock } = await import('./ledger.ts');
    if (!record.cleared) await withLedger(() => clearCapturedEdits(repo, record));
    record.cleared = true;
    Object.assign(record, { status: 'running', owner: processIdentity(process.pid) });
    save(path, record);
    const { gateTrainCandidate, regenerateGeneratedOutputs, writeMergeEvent } = await import('./merge.ts');
    const { normalizeMigrations } = await import('./merge-normalise.ts');
    const { reinstallStaleDependencies, missingPinnedImage } = await import('./typecheck-gate.ts');
    const { ensureDependencies } = await import('./dependencies.ts');
    mkdirSync(join(directory, 'manager-trees'), { recursive: true });
    if (!existsSync(worktree)) git(repo, ['worktree', 'add', '-B', branch, worktree, record.source]);
    await runMergeTrain({
      directory, id, handoffAt: record.queuedAt,
      head: () => git(repo, ['rev-parse', 'main']),
      prepare: async base => {
        spawnSync('git', ['rebase', '--abort'], { cwd: worktree, stdio: 'ignore' });
        git(worktree, ['reset', '--hard', record.source]);
        git(worktree, ['rebase', '--onto', base, record.base]);
        const normalization = normalizeMigrations(worktree, branch, base);
        if (typeof normalization === 'string') throw new Error(normalization);
        const merge = { before: base, baseline: base, after: git(worktree, ['rev-parse', 'HEAD']),
          worktree, branch, sharers: [], committed: git(worktree, ['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean), tests: [] };
        const failure = reinstallStaleDependencies(worktree) ?? missingPinnedImage(worktree, repo)
          ?? regenerateGeneratedOutputs(merge) ?? missingPinnedImage(worktree, repo);
        if (failure) throw new Error(failure);
        return merge;
      },
      gate: (merge, context) => gateTrainCandidate(merge, id, undefined, undefined, undefined, context),
      finish: async (merge, failure) => {
        if (failure) throw new Error(failure);
        await withLedger(() => {
          const head = git(repo, ['rev-parse', 'main']);
          if (head !== merge.before) {
            if (spawnSync('git', ['merge-base', '--is-ancestor', merge.after, head], { cwd: repo }).status === 0) return;
            throw new Error('Main changed outside the merge train');
          }
          if (git(worktree, ['rev-parse', 'HEAD']) !== merge.after || git(worktree, ['status', '--porcelain']))
            throw new Error('Manager candidate changed during its gate');
          const result = retryGitIndexLock(() => spawnSync('git', ['merge', '--ff-only', merge.after], { cwd: repo, encoding: 'utf8' }));
          if (result.status !== 0) throw new Error(result.stderr);
          ensureDependencies(repo);
          writeMergeEvent({ before: merge.before, after: merge.after, goal: record.goal,
            taskIds: [], at: new Date().toISOString() }, merge.committed);
        });
        record.after = merge.after;
      },
    });
    record.status = 'landed';
    save(path, record);
    // Cleanup cannot turn an already landed snapshot into a failed landing.
    spawnSync('git', ['worktree', 'remove', worktree], { cwd: repo, stdio: 'ignore' });
    spawnSync('git', ['branch', '-D', branch], { cwd: repo, stdio: 'ignore' });
    git(repo, ['update-ref', '-d', `refs/goal-manager/${id}`]);
  } catch (error) {
    if (record.status === 'landed') throw error;
    cancelTrainReservation(directory, id);
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    save(path, record);
    throw error;
  } finally { lease.release(); }
}

/** Settlement restarts a snapshot whose executor died; failures remain reviewable, never silently retried. */
export function pumpManagerCommits(repo: string, directory: string): void {
  const pending = join(directory, 'manager-commits');
  if (!existsSync(pending)) return;
  for (const record of pendingCommits(pending)) {
    if (record.status === 'landed' || record.status === 'failed' || (record.owner && processAlive(record.owner))) continue;
    const child = spawn(process.execPath, [import.meta.filename, repo, directory, record.id],
      { cwd: repo, detached: true, stdio: 'ignore', env: { ...process.env, GOAL_ID: record.goal } });
    child.unref();
  }
}

function pendingCommits(pending: string): ManagerCommit[] {
  return readdirSync(pending).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(pending, name), 'utf8')) as ManagerCommit)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function drainManagerCommits(repo: string, directory: string, goal?: string): Promise<void> {
  const pending = join(directory, 'manager-commits');
  if (!existsSync(pending)) return;
  for (const record of pendingCommits(pending).filter(record => !goal || record.goal === goal)) {
    if (record.status !== 'landed') await runManagerCommit(repo, directory, record.id);
  }
}

if (import.meta.main) await runManagerCommit(process.argv[2]!, process.argv[3]!, process.argv[4]!);
