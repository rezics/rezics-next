import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, Task } from './types.ts';
import type { FirstFailure } from './contracts.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';

function git(cwd: string, args: string[], policy: ControlPolicy['evidence']): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: policy.gitBufferBytes, timeout: policy.commandTimeoutMs });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || 'Cannot capture evidence');
  return result.stdout.trim();
}

function oneLine(value: string, limit: number): string {
  const line = value.replace(/[\r\n\t ]+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function commandLine(command: readonly string[]): string {
  return command.map((part) => (/[\s"']/u.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function failureOutput(value: string, policy: ControlPolicy['evidence']): string {
  const lines = value.split(/\r?\n/).slice(0, policy.outputLines);
  let output = lines.join('\n');
  if (output.length > policy.outputCharacters) output = `${output.slice(0, policy.outputCharacters - 1)}…`;
  return output;
}

function hypothesis(attempt: Attempt, policy: ControlPolicy['evidence']): string | null {
  const sources = [attempt.result, ...attempt.approaches.map((item) => `${item.approach}\n${item.result}`)];
  for (const source of sources) {
    try {
      const value = JSON.parse(source) as Record<string, unknown>;
      const stated = value.unresolvedHypothesis ?? value.unresolved_hypothesis ?? value.hypothesis;
      if (typeof stated === 'string' && stated.trim()) return oneLine(stated, policy.fieldCharacters);
    } catch {
      /* The legacy result and approach fields are plain text. */
    }
    const match = /(?:unresolved\s+)?hypothesis\s*[:=\-]\s*(.+)/im.exec(source);
    if (match?.[1]?.trim()) return oneLine(match[1], policy.fieldCharacters);
  }
  return null;
}

function worktreeStatus(task: Task, policy: ControlPolicy['evidence']): { summary: string; changedPaths: string[]; stat: string } {
  const status = git(task.worktree, ['status', '--porcelain=v1', '--untracked-files=normal'], policy);
  const changed = git(task.worktree, ['diff', '--name-only', '-z', task.base, '--'], policy).split('\0').filter(Boolean);
  const untracked = git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z'], policy)
    .split('\0')
    .filter(Boolean);
  const changedPaths = [...new Set([...changed, ...untracked])].sort();
  const staged = status.split('\n').filter((line) => line && line[0] !== ' ' && line[0] !== '?').length;
  const modified = status
    .split('\n')
    .filter((line) => line && (line[1] === 'M' || line[1] === 'D' || line[1] === 'R')).length;
  const untrackedCount = status.split('\n').filter((line) => line.startsWith('??')).length;
  const summary = !status ? 'clean' : `dirty (${staged} staged, ${modified} modified, ${untrackedCount} untracked)`;
  const trackedStat = git(task.worktree, ['diff', '--stat', task.base, '--'], policy);
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
  policy: ControlPolicy['evidence'],
): string {
  const approaches = attempt.approaches
    .slice(-policy.approaches)
    .map((item) => `- ${oneLine(item.approach, policy.approachCharacters)} — ${oneLine(item.result, policy.approachResultCharacters)}`);
  const output = failure?.excerpt ?? attempt.blocker ?? attempt.result ?? '';
  const exactAssertion = output
    .split(/\r?\n/)
    .find((line) => /AssertionError|\bError:|expected|expect\(|received|actual|panic|not ok/i.test(line));
  const assertion =
    exactAssertion ?? failure?.assertion ?? attempt.blocker ?? attempt.result ?? 'No assertion recorded.';
  const command = attempt.failureCommand?.length ? attempt.failureCommand : task.brief.acceptance.command;
  const pathList = allPaths.map((path) => JSON.stringify(path)).join('\n');
  const visiblePaths =
    pathList.length > policy.pathCharacters ? `${pathList.slice(0, Math.min(policy.visiblePathCharacters, policy.pathCharacters))}\n[complete path list is in diff.patch]` : pathList || '(none)';
  const manifest = [
    '# Retry manifest',
    '',
    `Unchanged contract: ${join(directory, 'contract.md')}`,
    `Base commit: ${base}`,
    `Head commit: ${head}`,
    `Worktree status: ${status.summary}`,
    '',
    `First failing command: ${oneLine(commandLine(command), policy.commandCharacters) || '(not recorded)'}`,
    `First assertion: ${oneLine(assertion, policy.fieldCharacters)}`,
    `Failure also occurs on base: ${attempt.failureOnBase === null || attempt.failureOnBase === undefined ? 'unknown' : attempt.failureOnBase ? 'yes' : 'no'}`,
    'Failure output:',
    failureOutput(output, policy) || '(no output captured)',
    '',
    'Diff stat:',
    status.stat.length > policy.statCharacters ? `${status.stat.slice(0, policy.statCharacters - 1)}…` : status.stat || '(no tracked diff stat)',
    'Changed paths:',
    visiblePaths,
    '',
    'Approaches already tried:',
    ...(approaches.length ? approaches : ['- (none recorded)']),
    '',
    `Unresolved hypothesis: ${hypothesis(attempt, policy) ?? '(none stated)'}`,
    '',
    `Full worker session log: ${attempt.logPath}`,
    `Full failure log: ${attempt.failureLogPath ?? '(not separately recorded)'}`,
    `Full patch and changed paths: ${join(directory, 'diff.patch')}`,
  ].join('\n');
  if (manifest.length <= policy.manifestCharacters) return manifest;
  // The detailed artifacts remain on disk; trim only the prompt copy when an unusually large path or status list
  // would otherwise push this handoff beyond its approximate two-thousand-token budget.
  const suffix = '\n\n[manifest shortened; full evidence is in the paths above]\n';
  return (manifest.slice(0, Math.max(0, policy.manifestCharacters - suffix.length)) + suffix).slice(0, policy.manifestCharacters);
}

/** No session text enters the evidence directory. All consultation input is assembled here. */
export function evidenceBundle(task: Task, attempt: Attempt, failure: FirstFailure | null = attempt.failure, policy = defaultPolicy.evidence): string {
  const directory = attempt.evidencePath;
  const base = git(task.worktree, ['rev-parse', task.base], policy);
  const head = git(task.worktree, ['rev-parse', 'HEAD'], policy);
  const status = worktreeStatus(task, policy);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'contract.md'), task.brief.markdown);
  // Include uncommitted edits and staged changes as well as branch commits.
  let diff = git(task.worktree, ['diff', '--no-ext-diff', '--binary', task.base, '--'], policy);
  const untracked = git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z'], policy)
    .split('\0')
    .filter(Boolean);
  for (const path of untracked) {
    const patch = spawnSync('git', ['diff', '--no-ext-diff', '--binary', '--no-index', '--', '/dev/null', path], {
      cwd: task.worktree,
      encoding: 'utf8',
      maxBuffer: policy.gitBufferBytes,
      timeout: policy.commandTimeoutMs,
    });
    if (patch.status !== 0 && patch.status !== 1) throw new Error('could not capture untracked diff');
    diff += `\n${patch.stdout}`;
  }
  writeFileSync(join(directory, 'diff.patch'), diff);
  const failureRecord =
    failure ??
    (attempt.failureKind
      ? { kind: attempt.failureKind, detail: (attempt.blocker ?? attempt.result).slice(0, policy.failureCharacters) }
      : null);
  const failureDocument =
    failureRecord && typeof failureRecord === 'object'
      ? {
          ...failureRecord,
          manifest: buildManifest(task, attempt, failure, directory, base, head, status, status.changedPaths, policy),
        }
      : {
          failure: failureRecord,
          manifest: buildManifest(task, attempt, failure, directory, base, head, status, status.changedPaths, policy),
        };
  writeFileSync(join(directory, 'failure.json'), JSON.stringify(failureDocument, null, 2));
  writeFileSync(join(directory, 'approaches.json'), JSON.stringify(attempt.approaches, null, 2));
  return directory;
}
