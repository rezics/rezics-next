import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readBriefContinuation, readResearchFanout } from './briefs.ts';
import {
  BACKLOG_DISPATCHED_DIRECTORY as DISPATCHED_DIRECTORY,
  BACKLOG_DISPATCHING_DIRECTORY as CLAIM_DIRECTORY,
  BACKLOG_FAILED_DIRECTORY as FAILED_DIRECTORY,
  backlogDirectory,
  briefs,
  errorText,
  stem,
  tableExists,
  taskLintWarnings,
} from './backlog-shared.ts';

type BacklogClaimRuntime = {
  db: Database;
  stateDirectory: string;
  now?: () => number;
};

function failedBriefName(file: string, sequence: number): string {
  if (sequence === 1) return basename(file);
  const suffix = `-${sequence}`;
  // POSIX filename components are bounded in bytes, independently of control-plane policy.
  const maxStemBytes = 255 - Buffer.byteLength(`${suffix}.md`);
  let name = '';
  for (const character of stem(file)) {
    const next = name + character;
    if (Buffer.byteLength(next) > maxStemBytes) break;
    name = next;
  }
  return `${name}${suffix}.md`;
}

function failureFingerprint(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function proposalFingerprint(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function finishInterruptedFailure(
  failed: string,
  file: string,
  fingerprint: string,
): { brief: string; reason: string } | undefined {
  const marker = `<!-- backlog-refusal:${fingerprint} -->`;
  for (let sequence = 1; ; sequence++) {
    const name = failedBriefName(file, sequence);
    const briefPath = join(failed, name);
    const reasonPath = join(failed, `${stem(name)}.reason`);
    if (existsSync(briefPath)) continue;
    if (!existsSync(reasonPath)) return undefined;
    const storedReason = readFileSync(reasonPath, 'utf8');
    if (!storedReason.trimEnd().endsWith(marker)) continue;
    renameSync(file, briefPath);
    const markerStart = storedReason.lastIndexOf('\n\n<!-- backlog-refusal:');
    return { brief: name, reason: storedReason.slice(0, markerStart).trimEnd() };
  }
}

/** Move a brief into `failed/` beside a `.reason` file holding the refusal. */
export function fail(goalDirectory: string, file: string, reason: string): string {
  const failed = join(goalDirectory, FAILED_DIRECTORY);
  mkdirSync(failed, { recursive: true });
  const refusal = reason.trim();
  const fingerprint = failureFingerprint(file);
  const marker = `<!-- backlog-refusal:${fingerprint} -->`;
  const resumed = finishInterruptedFailure(failed, file, fingerprint);
  if (resumed) return resumed.brief;
  for (let sequence = 1; ; sequence++) {
    const name = failedBriefName(file, sequence);
    const briefPath = join(failed, name);
    const reasonPath = join(failed, `${stem(name)}.reason`);
    if (existsSync(briefPath)) continue;
    if (existsSync(reasonPath)) {
      if (readFileSync(reasonPath, 'utf8').trimEnd().endsWith(marker)) {
        renameSync(file, briefPath);
        return name;
      }
      continue;
    }

    const temporaryReason = join(failed, `.${name}.reason.tmp`);
    writeFileSync(temporaryReason, `${refusal}\n\n${marker}\n`);
    renameSync(temporaryReason, reasonPath);
    renameSync(file, briefPath);
    return name;
  }
}

function returnClaimToReady(goalDirectory: string, file: string): void {
  const ready = join(goalDirectory, basename(file));
  if (existsSync(ready)) throw new Error(`cannot recover claim because ${basename(file)} already exists`);
  renameSync(file, ready);
}

function taskHasDispatchArchive(goalDirectory: string, taskId: string): boolean {
  try {
    const prefix = `${taskId}-`;
    return readdirSync(join(goalDirectory, DISPATCHED_DIRECTORY)).some(
      (name) => name.startsWith(prefix) && name.endsWith('.md'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Unarchived tasks in this Goal whose stored brief text is this claim. */
function unarchivedTasksForBrief(runtime: BacklogClaimRuntime, goal: string, markdown: string): string[] {
  if (!tableExists(runtime.db, 'worker_tasks')) return [];
  const goalDirectory = backlogDirectory(runtime.stateDirectory, goal);
  const proposalSha256 = proposalFingerprint(markdown);
  const ids: string[] = [];
  for (const row of runtime.db.query('SELECT id, body FROM worker_tasks').all() as { id: string; body: string }[]) {
    let task: {
      brief?: {
        goal?: string;
        markdown?: string;
        kind?: string;
        proof?: { sourceTasks?: string[] };
      };
      proofAuthorization?: {
        backlogProposal?: { proposalSha256?: string; sourceTasks?: string[] };
      };
    };
    try {
      task = JSON.parse(row.body) as typeof task;
    } catch {
      continue;
    }
    const brief = task.brief;
    if (brief?.goal !== goal) continue;
    const admission = task.proofAuthorization?.backlogProposal;
    const sameProposal =
      brief.markdown === markdown ||
      (brief.kind === 'verification' &&
        admission?.proposalSha256 === proposalSha256 &&
        JSON.stringify(admission.sourceTasks) === JSON.stringify(brief.proof?.sourceTasks));
    if (!sameProposal) continue;
    if (taskHasDispatchArchive(goalDirectory, row.id)) continue;
    ids.push(row.id);
  }
  return ids.sort();
}

function archiveCommittedClaim(runtime: BacklogClaimRuntime, goal: string, file: string, taskId: string): void {
  const goalDirectory = backlogDirectory(runtime.stateDirectory, goal);
  const target = join(goalDirectory, DISPATCHED_DIRECTORY);
  mkdirSync(target, { recursive: true });
  const dest = join(target, `${taskId}-${basename(file)}`);
  if (existsSync(dest)) {
    if (readFileSync(dest, 'utf8') !== readFileSync(file, 'utf8'))
      throw new Error(
        `cannot archive interrupted dispatch of ${basename(file)} onto task ${taskId} because ${dest} already exists with different contents`,
      );
    rmSync(file);
    return;
  }
  const written = statSync(file).mtimeMs;
  renameSync(file, dest);
  recordGoalDispatch(runtime, goal, written);
}

/** Record the write time and dispatch time for a committed backlog operation. */
export function recordGoalDispatch(runtime: BacklogClaimRuntime, goal: string, writtenMs: number): void {
  runtime.db
    .query(
      `INSERT INTO backlog_goals(goal, last_dispatch_at, last_written_at) VALUES (?, ?, ?)
        ON CONFLICT(goal) DO UPDATE SET last_dispatch_at = excluded.last_dispatch_at,
          last_written_at = max(coalesce(last_written_at, 0), excluded.last_written_at)`,
    )
    .run(goal, (runtime.now ?? Date.now)(), Math.floor(writtenMs));
}

/**
 * A claim left by a host that stopped mid-dispatch: archive a unique committed task, return an uncommitted
 * claim to ready, and refuse when several unarchived tasks share this brief.
 */
export function recoverClaims(
  runtime: BacklogClaimRuntime,
  goal: string,
): { dispatched: { taskId: string; brief: string }[]; refused: { brief: string; reason: string }[] } {
  const goalDirectory = backlogDirectory(runtime.stateDirectory, goal);
  const dispatched: { taskId: string; brief: string }[] = [];
  const refused: { brief: string; reason: string }[] = [];
  for (const file of briefs(join(goalDirectory, CLAIM_DIRECTORY))) {
    try {
      const interruptedFailure = finishInterruptedFailure(
        join(goalDirectory, FAILED_DIRECTORY),
        file,
        failureFingerprint(file),
      );
      if (interruptedFailure) {
        refused.push(interruptedFailure);
        continue;
      }
      const markdown = readFileSync(file, 'utf8');
      if (readResearchFanout(markdown)) continue;
      if (readBriefContinuation(markdown)) {
        returnClaimToReady(goalDirectory, file);
        continue;
      }
      const matches = unarchivedTasksForBrief(runtime, goal, markdown);
      if (matches.length > 1)
        throw new Error(
          `Interrupted dispatch of ${basename(file)} matches multiple unarchived tasks (${matches.join(', ')}). Inspect those tasks and archive or fail this brief by hand; do not submit it again.`,
        );
      if (matches.length === 1) {
        archiveCommittedClaim(runtime, goal, file, matches[0]!);
        const lintWarnings = taskLintWarnings(runtime.db, matches[0]!);
        dispatched.push({
          taskId: matches[0]!,
          brief: basename(file),
          ...(lintWarnings.length ? { lintWarnings } : {}),
        });
        continue;
      }
      returnClaimToReady(goalDirectory, file);
    } catch (error) {
      const reason = errorText(error);
      try {
        const archivedBrief = fail(goalDirectory, file, reason);
        refused.push({ brief: archivedBrief, reason });
      } catch (moveError) {
        console.error(`backlog claim recovery failed for ${file}:`, moveError);
      }
    }
  }
  return { dispatched, refused };
}
