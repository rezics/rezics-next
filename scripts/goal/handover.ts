import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { attachCallingTests, buildOperationIndex, formatHumanResult, searchOperations } from '../api/operation-index.ts';
import { outOfScope } from './briefs.ts';
import { root } from './ledger.ts';
import { codexAccounts } from './usage.ts';
import type { AccountUsage, Brief, Engine, Ledger, Task } from './types.ts';

export interface WorkerHandover {
  brief: string;
  refs: { path: string; bytes: Buffer }[];
  operations: string;
}

function closedReference(repository: string, location: string): string | undefined {
  const brief = /^docs\/goals\/([^/]+)\/tasks\/(G-\d+)\.md$/.exec(location);
  const artifact = /^\.temp\/worktrees\/(g-\d+)\/\.temp\/goal\/(.+)$/.exec(location);
  const id = brief?.[2] ?? artifact?.[1]?.toUpperCase();
  if (!id) return;
  const ledgerFile = join(repository, '.temp/goal-orchestration/ledger.json');
  if (!statSync(ledgerFile, { throwIfNoEntry: false })?.isFile()) return;
  const task = (JSON.parse(readFileSync(ledgerFile, 'utf8')) as Ledger).tasks[id];
  if (!task || !['verified', 'cancelled'].includes(task.state) || (brief && task.goal !== brief[1])) return;
  return join(repository, '.temp/goal-orchestration/runs', id, 'worktree-temp/goal', artifact?.[2] ?? 'brief.md');
}

/** Resolve and read references before creating a worktree, so a bad brief leaves no partial dispatch. */
export async function prepareHandover(brief: Brief, text: string, repository = root): Promise<WorkerHandover> {
  const names = new Set<string>();
  const refs = (brief.refs ?? []).map(file => {
    let source = resolve(repository, file);
    const location = relative(repository, source);
    if (isAbsolute(location) || location === '..' || location.startsWith('../')) {
      throw new Error(`Reference must be in the main checkout: ${file}`);
    }
    const name = basename(source);
    if (names.has(name)) throw new Error(`References have the same file name: ${name}`);
    names.add(name);
    if (!statSync(source, { throwIfNoEntry: false })) source = closedReference(repository, location) ?? source;
    if (!statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`Reference does not exist or is not a file: ${file}`);
    return { path: `.temp/ref/${name}`, bytes: readFileSync(source) };
  });
  const queries = brief.operations ?? [];
  if (queries.length > 60) throw new Error('A brief can carry at most 60 operation queries in its 60-line operation context');
  const index = queries.length ? await buildOperationIndex(repository) : [];
  const results = queries.map(query => searchOperations(index, query));
  if (results.length) attachCallingTests(results.flatMap(result => result.matches), repository);
  // Give every query room, even when the first one has many matches and calling tests.
  const operations = results.flatMap((result, i) => {
    const lines = [`Operation query: ${queries[i]}`, ...formatHumanResult(result).split('\n')];
    const budget = Math.floor(60 / queries.length) + (i < 60 % queries.length ? 1 : 0);
    return lines.length <= budget ? lines : [...lines.slice(0, budget - 1), `${lines[budget - 1]} [truncated; narrow the query]`];
  }).join('\n');
  return { brief: text, refs, operations };
}

export function stageHandover(worktree: string, handover: WorkerHandover): void {
  if (!handover.refs.length) return;
  mkdirSync(join(worktree, '.temp/ref'), { recursive: true });
  for (const ref of handover.refs) writeFileSync(join(worktree, ref.path), ref.bytes);
}

export function handoverPrompt(handover: WorkerHandover, tests: readonly string[]): string {
  return [
    `Staged references: ${handover.refs.map(ref => ref.path).join(', ') || 'none'}`,
    `Tests: ${tests.join(', ') || 'none'}`,
    ...(handover.operations ? [`API operations (at most 60 lines):\n${handover.operations}`] : []),
    `Your brief follows; follow it without reading its copy as another step:\n${handover.brief}`,
  ].join('\n\n');
}

/** Resolve the account once at dispatch. Missing weekly figures cannot establish that an account has more left. */
export function solAccount(accounts: readonly AccountUsage[] = codexAccounts()): 'codex' | 'codex-1' {
  const known = accounts.filter(account => (account.account === 'codex' || account.account === 'codex-1')
    && account.weekUsed !== undefined);
  const selected = known.reduce<AccountUsage | undefined>((best, account) =>
    !best || account.weekUsed! < best.weekUsed! ? account : best, undefined);
  return selected?.account === 'codex-1' ? 'codex-1' : 'codex';
}

export function dispatchEngine(engine: Engine): Engine {
  return engine === 'sol' ? solAccount() : engine;
}

/** Read-only evidence: include both sides of a rename and preserve names with spaces or Git quoting characters. */
export function strayFiles(task: Pick<Task, 'paths'>, repository = root): string[] {
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repository, encoding: 'utf8' });
  if (status.status !== 0) throw new Error(`Cannot inspect main checkout stray writes: ${status.stderr}`);
  const entries = status.stdout.split('\0');
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    files.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) files.push(entries[++i]!);
  }
  const outside = new Set(outOfScope(files, task.paths));
  return [...new Set(files.filter(file => !outside.has(file)))].sort();
}
