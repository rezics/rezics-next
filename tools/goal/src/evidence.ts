import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, Task } from './types.ts';
import type { FirstFailure } from './contracts.ts';
import { git } from './tasks.ts';

const MANIFEST_LIMIT = 8_000;

function oneLine(value: string, limit: number): string {
  const line = value.replace(/[\r\n\t ]+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function commandLine(command: readonly string[]): string {
  return command.map((part) => (/[\s"']/u.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function failureOutput(value: string): string {
  const lines = value.split(/\r?\n/).slice(0, 60);
  let output = lines.join('\n');
  if (output.length > 2_800) output = `${output.slice(0, 2_799)}…`;
  return output;
}

function hypothesis(attempt: Attempt): string | null {
  const sources = [attempt.result, ...attempt.approaches.map((item) => `${item.approach}\n${item.result}`)];
  for (const source of sources) {
    try {
      const value = JSON.parse(source) as Record<string, unknown>;
      const stated = value.unresolvedHypothesis ?? value.unresolved_hypothesis ?? value.hypothesis;
      if (typeof stated === 'string' && stated.trim()) return oneLine(stated, 500);
    } catch {
      /* The legacy result and approach fields are plain text. */
    }
    const match = /(?:unresolved\s+)?hypothesis\s*[:=\-]\s*(.+)/im.exec(source);
    if (match?.[1]?.trim()) return oneLine(match[1], 500);
  }
  return null;
}

function worktreeStatus(task: Task): { summary: string; changedPaths: string[]; stat: string } {
  const status = git(task.worktree, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const changed = git(task.worktree, ['diff', '--name-only', task.base, '--']).split('\n').filter(Boolean);
  const untracked = git(task.worktree, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const changedPaths = [...new Set([...changed, ...untracked])].sort();
  const staged = status.split('\n').filter((line) => line && line[0] !== ' ' && line[0] !== '?').length;
  const modified = status
    .split('\n')
    .filter((line) => line && (line[1] === 'M' || line[1] === 'D' || line[1] === 'R')).length;
  const untrackedCount = status.split('\n').filter((line) => line.startsWith('??')).length;
  const summary = !status ? 'clean' : `dirty (${staged} staged, ${modified} modified, ${untrackedCount} untracked)`;
  const trackedStat = git(task.worktree, ['diff', '--stat', task.base, '--']);
  const stat = [trackedStat, untracked.length ? `${untracked.length} untracked file(s)` : '']
    .filter(Boolean)
    .join('\n');
  return { summary, changedPaths, stat };
}

function buildManifest(
  task: Task,
  attempt: Attempt,
  failure: FirstFailure | null,
  directory: string,
  base: string,
  head: string,
  status: ReturnType<typeof worktreeStatus>,
  allPaths: string[],
): string {
  const approaches = attempt.approaches
    .slice(-3)
    .map((item) => `- ${oneLine(item.approach, 140)} — ${oneLine(item.result, 160)}`);
  const output = failure?.excerpt ?? attempt.blocker ?? attempt.result ?? '';
  const exactAssertion = output
    .split(/\r?\n/)
    .find((line) => /AssertionError|\bError:|expected|expect\(|received|actual|panic|not ok/i.test(line));
  const assertion =
    exactAssertion ?? failure?.assertion ?? attempt.blocker ?? attempt.result ?? 'No assertion recorded.';
  const command = attempt.failureCommand?.length ? attempt.failureCommand : task.brief.acceptance.command;
  const pathList = allPaths.join('\n');
  const visiblePaths =
    pathList.length > 800 ? `${pathList.slice(0, 700)}\n[complete path list is in diff.patch]` : pathList || '(none)';
  const manifest = [
    '# Retry manifest',
    '',
    `Unchanged contract: ${join(directory, 'contract.md')}`,
    `Base commit: ${base}`,
    `Head commit: ${head}`,
    `Worktree status: ${status.summary}`,
    '',
    `First failing command: ${oneLine(commandLine(command), 250) || '(not recorded)'}`,
    `First assertion: ${oneLine(assertion, 500)}`,
    `Failure also occurs on base: ${attempt.failureOnBase === null || attempt.failureOnBase === undefined ? 'unknown' : attempt.failureOnBase ? 'yes' : 'no'}`,
    'Failure output:',
    failureOutput(output) || '(no output captured)',
    '',
    'Diff stat:',
    status.stat.length > 250 ? `${status.stat.slice(0, 249)}…` : status.stat || '(no tracked diff stat)',
    'Changed paths:',
    visiblePaths,
    '',
    'Approaches already tried:',
    ...(approaches.length ? approaches : ['- (none recorded)']),
    '',
    `Unresolved hypothesis: ${hypothesis(attempt) ?? '(none stated)'}`,
    '',
    `Full worker session log: ${attempt.logPath}`,
    `Full failure log: ${attempt.failureLogPath ?? '(not separately recorded)'}`,
    `Full patch and changed paths: ${join(directory, 'diff.patch')}`,
  ].join('\n');
  if (manifest.length <= MANIFEST_LIMIT) return manifest;
  // The detailed artifacts remain on disk; trim only the prompt copy when an unusually large path or status list
  // would otherwise push this handoff beyond its approximate two-thousand-token budget.
  return `${manifest.slice(0, MANIFEST_LIMIT - 64)}\n\n[manifest shortened; full evidence is in the paths above]\n`;
}

/** No session text enters the evidence directory. All consultation input is assembled here. */
export function evidenceBundle(task: Task, attempt: Attempt, failure: FirstFailure | null = attempt.failure): string {
  const directory = attempt.evidencePath;
  const base = git(task.worktree, ['rev-parse', task.base]);
  const head = git(task.worktree, ['rev-parse', 'HEAD']);
  const status = worktreeStatus(task);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'contract.md'), task.brief.markdown);
  // Include uncommitted edits and staged changes as well as branch commits.
  let diff = git(task.worktree, ['diff', '--no-ext-diff', '--binary', task.base, '--']);
  const untracked = git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  for (const path of untracked) {
    const patch = spawnSync('git', ['diff', '--no-ext-diff', '--binary', '--no-index', '--', '/dev/null', path], {
      cwd: task.worktree,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (patch.status !== 0 && patch.status !== 1) throw new Error('could not capture untracked diff');
    diff += `\n${patch.stdout}`;
  }
  writeFileSync(join(directory, 'diff.patch'), diff);
  const failureRecord =
    failure ??
    (attempt.failureKind
      ? { kind: attempt.failureKind, detail: (attempt.blocker ?? attempt.result).slice(0, 4000) }
      : null);
  const failureDocument =
    failureRecord && typeof failureRecord === 'object'
      ? {
          ...failureRecord,
          manifest: buildManifest(task, attempt, failure, directory, base, head, status, status.changedPaths),
        }
      : {
          failure: failureRecord,
          manifest: buildManifest(task, attempt, failure, directory, base, head, status, status.changedPaths),
        };
  writeFileSync(join(directory, 'failure.json'), JSON.stringify(failureDocument, null, 2));
  writeFileSync(join(directory, 'approaches.json'), JSON.stringify(attempt.approaches, null, 2));
  return directory;
}
