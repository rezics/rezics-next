import type { Database } from 'bun:sqlite';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { agentAdapter } from './agents.ts';
import { parseBrief, pathsOverlap, readRiskOwnership } from './briefs.ts';
import { ensureFlow, recordFlow } from './flow.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { attemptSession } from './records.ts';
import type { WorkerStore } from './store.ts';
import type { WorkerTasks } from './tasks.ts';
import type { Attempt, Brief, ChainLink, Cli, Settings, Task } from './types.ts';

// A landed attempt offers its warm provider session to the next overlapping brief of its Goal. Verification proofs,
// research and claims keep their own sessions, so they are never chained.
const CHAINABLE_KINDS: ReadonlySet<Brief['kind']> = new Set([
  'implementation',
  'interface',
  'bulk-text',
  'mechanical',
  'specification',
]);

/** Whether a brief may sit on either side of a chain: ordinary product work that is neither urgent nor a continuation. */
export function chainableBrief(brief: Brief): boolean {
  return CHAINABLE_KINDS.has(brief.kind) && !brief.urgent && !brief.continuation;
}

/** A landed attempt's offer, recorded at landing and read back by the backlog run. */
export type ChainOffer = {
  taskId: string;
  attempt: number;
  goal: string;
  target: 'stabilize' | 'main' | null;
  paths: string[];
  session: string;
  cli: Cli;
  pool: string;
  model: string;
  effort: string;
  depth: number;
};

/** Offer a landed attempt's session. The backlog run decides, so landing never waits for a worktree or a Git command. */
export function recordChainOffer(
  db: Database,
  task: Task,
  attempt: Attempt,
  at: string,
  policy: ControlPolicy['records'] = defaultPolicy.records,
): void {
  if (!chainableBrief(task.brief) || !attempt.profile || !agentAdapter(attempt.profile.cli).canResume) return;
  const session = attemptSession(attempt, policy);
  if (!session) return;
  const offer: Omit<ChainOffer, 'taskId' | 'attempt'> = {
    goal: task.brief.goal,
    target: task.brief.target ?? null,
    paths: [...task.brief.paths],
    session,
    cli: attempt.profile.cli,
    pool: attempt.pool,
    model: attempt.profile.model,
    effort: attempt.profile.effort,
    depth: task.chain?.depth ?? 1,
  };
  recordFlow(db, {
    taskId: task.id,
    attempt: attempt.attempt,
    stage: 'chain',
    action: 'offered',
    at,
    detail: JSON.stringify(offer),
  });
}

/** Offers recorded since `since` that no decision has answered. The window bounds the read, not the history. */
export function pendingChainOffers(db: Database, since: string): ChainOffer[] {
  ensureFlow(db);
  return (
    db
      .query(
        `SELECT o.task_id AS taskId, o.attempt, o.detail FROM flow_events o
          WHERE o.stage = 'chain' AND o.action = 'offered' AND o.at >= ?
            AND NOT EXISTS (
              SELECT 1 FROM flow_events d
              WHERE d.stage = 'chain' AND d.action IN ('chained', 'declined')
                AND d.task_id = o.task_id AND d.attempt = o.attempt)
          ORDER BY o.sequence`,
      )
      .all(since) as { taskId: string; attempt: number; detail: string }[]
  ).map((row) => ({
    taskId: row.taskId,
    attempt: row.attempt,
    ...(JSON.parse(row.detail) as Omit<ChainOffer, 'taskId' | 'attempt'>),
  }));
}

/** Answer an offer. Every offer gets exactly one answer, so a restarted run never chains it twice. */
export function recordChainDecision(
  db: Database,
  offer: Pick<ChainOffer, 'taskId' | 'attempt'>,
  action: 'chained' | 'declined',
  at: string,
  detail: Record<string, unknown>,
): void {
  recordFlow(db, {
    taskId: offer.taskId,
    attempt: offer.attempt,
    stage: 'chain',
    action,
    at,
    detail: JSON.stringify(detail),
  });
}

/** The link the chained task records: its first attempt resumes the offered session. */
export function chainLinkFor(offer: ChainOffer): ChainLink {
  return {
    from: { taskId: offer.taskId, attempt: offer.attempt },
    session: offer.session,
    cli: offer.cli,
    pool: offer.pool,
    model: offer.model,
    effort: offer.effort,
    depth: offer.depth + 1,
  };
}

/** Why an offer ends its session instead of chaining, or null when the next overlapping brief may chain. */
export function chainStopReason(
  depth: number,
  contextTokens: () => number | null,
  policy: ControlPolicy['chain'] = defaultPolicy.chain,
): string | null {
  if (depth >= policy.maximumTasks) return 'maximum-tasks';
  const tokens = contextTokens();
  if (tokens === null) return 'context-unknown';
  if (tokens >= policy.maximumContextTokens) return 'context-limit';
  return null;
}

/** Overlap as the Goal's briefs define it: shared paths such as documentation never link two briefs. */
export function chainOverlaps(
  landed: readonly string[],
  candidate: readonly string[],
  policy: ControlPolicy['brief'] = defaultPolicy.brief,
): boolean {
  const own = (paths: readonly string[]) =>
    paths.filter((path) => !policy.sharedPaths.some((shared) => pathsOverlap(path, shared, policy)));
  const right = own(candidate);
  return own(landed).some((path) => right.some((other) => pathsOverlap(path, other, policy)));
}

/** A Claude transcript lives under the project directory of the cwd that started it, and a resume appends there. */
function transcriptPath(cli: Cli, configDirectory: string, session: string): string | null {
  if (cli === 'codex') return agentAdapter('codex').readSessionPath?.(configDirectory, session) ?? null;
  if (cli !== 'claude') return null;
  const projects = join(configDirectory, 'projects');
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const path = join(projects, project, `${session}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** The last `bytes` of a transcript as whole lines, newest first. */
function tailLines(path: string, bytes: number): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // A read that starts mid-file begins with a partial record.
    if (length < size) lines.shift();
    return lines.reverse();
  } finally {
    closeSync(fd);
  }
}

/** Input tokens of the model request a transcript line reports, or null for any other line. */
function requestInputTokens(cli: Cli, line: string): number | null {
  // Transcripts are written by the provider CLIs; a partial or foreign line is simply not a usage record.
  let event: Record<string, any>;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (cli === 'codex') {
    const input =
      event.type === 'event_msg' && event.payload?.type === 'token_count'
        ? event.payload.info?.last_token_usage?.input_tokens
        : undefined;
    return typeof input === 'number' && Number.isFinite(input) ? input : null;
  }
  const usage = event.type === 'assistant' ? event.message?.usage : undefined;
  if (!usage) return null;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
}

/** Context size of a retained session: the input of its latest model request, or null when no transcript shows one. */
export function sessionContextTokens(
  cli: Cli,
  configDirectory: string,
  session: string,
  policy: ControlPolicy['chain'] = defaultPolicy.chain,
): number | null {
  const path = transcriptPath(cli, configDirectory, session);
  if (!path) return null;
  for (const line of tailLines(path, policy.contextTailBytes)) {
    const tokens = requestInputTokens(cli, line);
    if (tokens !== null) return tokens;
  }
  return null;
}

/** What the backlog run needs from the composed runtime: transcript reads, brief parsing and the chained dispatch. */
export type ChainRuntime = {
  contextTokens(offer: ChainOffer): number | null;
  inspect(markdown: string): Brief | null;
  dispatch(briefFile: string, link: ChainLink): Promise<{ taskId: string }>;
};

export function chainRuntime(options: {
  settings: Settings;
  store: WorkerStore;
  tasks: Pick<WorkerTasks, 'dispatch'>;
}): ChainRuntime {
  const { settings, store, tasks } = options;
  return {
    contextTokens(offer) {
      const pool = settings.pools.find((candidate) => candidate.name === offer.pool);
      return pool ? sessionContextTokens(offer.cli, pool.configDirectory, offer.session, settings.policy?.chain) : null;
    },
    inspect(markdown) {
      // Manager-written briefs are external input. One that does not parse is left for the ordinary sweep to refuse.
      try {
        return parseBrief(
          markdown,
          readRiskOwnership(settings.riskAreasFile, settings.policy?.brief),
          settings.policy?.brief,
        );
      } catch {
        return null;
      }
    },
    async dispatch(briefFile, link) {
      // The `goal dispatch` path, then the link, then the durable first start that resumes the offered session.
      const task = tasks.dispatch(briefFile, null);
      store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.chain = link;
      });
      if (task.state !== 'held') store.saveRetryIntent({ taskId: task.id, attempt: 0 }, {});
      return { taskId: task.id };
    },
  };
}
