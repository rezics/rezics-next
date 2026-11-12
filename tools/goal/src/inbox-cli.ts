import type { Database } from 'bun:sqlite';
import type { AttemptFence, InboxDocumentReference, InboxEscalation, ManagerEventKind } from './contracts.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SharedInboxQueries, type SharedInboxFilter } from './inbox-shared.ts';
import { isPendingContinuationHandshake } from './manager-continuation.ts';
import {
  authenticatedCallingManager,
  isResidentSupermanagerRecord,
  recordManagerCommand,
} from './manager-command-context.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';

/** Inbox send/read/ack/wait/log/thread/digest parsing and output; `runIntegration` stays the public dispatcher. */
type InboxCommandRuntime = {
  db: Database;
  inbox?: SqliteManagerInbox;
  sharedInbox?: SharedInboxQueries;
  stateDirectory: string;
  supermanager?: string;
  fence: AttemptFence;
  managerServices: { policy?: ControlPolicy };
};

type InboxHost = {
  requestHost: (
    request: { command: 'decision' | 'outgoing-message'; manager?: string; recipient?: string; summary?: string },
    timeoutMs?: number,
  ) => Promise<unknown>;
  ensureHost: () => Promise<void>;
};

type InboxCliOptions = SharedInboxFilter & { json: boolean; reference?: string };

type ResolvedInboxSender = {
  from: string;
  managerId: string;
  sessionId?: string;
  worker?: { kind: 'worker'; taskId: string; attempt: number; ownerManager: string };
};

export async function runInboxCommand(argv: string[], runtime: InboxCommandRuntime, host: InboxHost): Promise<number> {
  const [, subcommand, id, ...flags] = argv;
  const policy = runtime.managerServices.policy ?? defaultPolicy;
  const inbox = runtime.inbox ?? new SqliteManagerInbox(runtime.db, runtime.stateDirectory, undefined, policy.inbox);
  const sharedInbox = runtime.sharedInbox ?? new SharedInboxQueries(runtime.db, policy.inbox);
  if (subcommand === 'send') {
    if (!id)
      throw new Error(
        'usage: inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>] [--reply <id>]',
      );
    const [kind, summary, ...options] = flags;
    if (!kind || !summary)
      throw new Error(
        'usage: inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>] [--reply <id>] [--document <reference>] [--escalation <metadata>]',
      );
    const values = new Map<string, string[]>();
    for (let index = 0; index < options.length; index += 2) {
      const option = options[index];
      const value = options[index + 1];
      const repeatable = option === '--document';
      if (
        !['--task', '--evidence', '--reply', '--document', '--escalation'].includes(option ?? '') ||
        !value ||
        (!repeatable && values.has(option!))
      )
        throw new Error(`invalid inbox send option: ${option ?? '(missing value)'}`);
      values.set(option!, [...(values.get(option!) ?? []), value]);
    }
    const allowed = [
      'question',
      'decision',
      'blocker',
      'handoff',
      'info',
      'spec-conflict',
      'scope-growth',
      'environment',
      'round-limit',
      'stalled',
      'failed-after-consult',
      'goal-unmet',
      'goal-met',
      'instruction',
    ];
    if (!allowed.includes(kind))
      throw new Error(`unknown inbox event kind: ${kind}. Valid kinds: ${allowed.join(', ')}`);
    if (/[\r\n]/.test(summary)) throw new Error('inbox event summary must be one line');
    let replyToId: number | undefined;
    if (values.has('--reply')) {
      const reference = values.get('--reply')![0]!;
      if (!/^\d+$/.test(reference) || !Number.isSafeInteger(Number(reference)) || Number(reference) <= 0)
        throw new Error('inbox --reply must be an existing positive message id');
      replyToId = Number(reference);
    }
    const documentRefs = (values.get('--document') ?? []).map(parseDocumentReference);
    const escalation = values.has('--escalation') ? parseEscalation(values.get('--escalation')![0]!) : undefined;
    const taskId = values.get('--task')?.[0];
    if (values.has('--task') && !taskId?.trim()) throw new Error('inbox --task must be nonempty');
    if (values.has('--evidence') && !values.get('--evidence')?.[0]?.trim())
      throw new Error('inbox --evidence must be nonempty');
    // A completed Goal has no lead reading its inbox; what it owned returns to the supermanager.
    const recipient = runtime.db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'")
      .get()
      ? (runtime.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null)
      : null;
    if (recipient && JSON.parse(recipient.state).status === 'complete')
      throw new Error(
        `manager ${id} has completed its Goal and reads no inbox; send to ${runtime.supermanager || 'supermanager'}`,
      );
    const deliver = (sender: ResolvedInboxSender): ResolvedInboxSender => {
      if (sender.worker && !['instruction', 'question', 'blocker', 'handoff', 'info'].includes(kind))
        throw new Error('workers may send only instruction, question, blocker, handoff, or info inbox messages');
      inbox.deliver({
        managerId: id,
        kind: kind as ManagerEventKind,
        summary,
        from: sender.from,
        ...(kind === 'decision' && sender.sessionId ? { senderSessionId: sender.sessionId } : {}),
        ...(sender.worker ? { senderProvenance: sender.worker } : {}),
        ...(taskId ? { taskId } : sender.worker ? { taskId: sender.worker.taskId } : {}),
        ...(values.get('--evidence')?.[0] ? { evidencePath: values.get('--evidence')![0] } : {}),
        ...(replyToId !== undefined ? { replyToId } : {}),
        ...(documentRefs.length ? { documentRefs } : {}),
        ...(escalation ? { escalation } : {}),
      });
      return sender;
    };
    let sender: ResolvedInboxSender;
    if (hasWorkerIdentityMarkers(process.env)) {
      // Keep the attempt fence valid through insert so a concurrent retry cannot race source attribution.
      sender = runtime.db.transaction(() => deliver(resolveInboxSender(runtime))).immediate();
    } else {
      const manager = resolveInboxSender(runtime);
      sender = manager;
      await recordManagerCommand(runtime);
      // Goal managers send decisions, questions and handoffs only; the supermanager directs every Goal.
      if (manager.managerId !== runtime.supermanager && !isResidentSupermanagerRecord(runtime, manager.managerId))
        runtime.db
          .transaction(() => {
            inbox.assertManagerSend(manager.from, summary, id);
            deliver(manager);
          })
          .immediate();
      else deliver(manager);
    }
    if (
      !sender.worker &&
      /continuation written/i.test(summary) &&
      runtime.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()
    ) {
      const source = runtime.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(sender.managerId) as {
        state: string;
      } | null;
      let state: unknown = null;
      try {
        state = source ? JSON.parse(source.state) : null;
      } catch {
        state = null;
      }
      if (isPendingContinuationHandshake(summary, id, state)) {
        await host.ensureHost();
        // The durable local decision is authoritative. Keep the host's legacy audit view in sync with a short,
        // isolated delivery attempt; its failure must not change the inbox-send or continuation result.
        await host
          .requestHost({ command: 'decision', manager: sender.managerId }, policy.host.decisionAuditTimeoutMs)
          .catch((error) => console.error(`manager decision audit delivery failed: ${String(error)}`));
        await host.requestHost({
          command: 'outgoing-message',
          manager: sender.managerId,
          recipient: id,
          summary,
        });
      }
    }
  } else if (subcommand === 'log' || subcommand === 'thread' || subcommand === 'digest') {
    const args =
      subcommand === 'thread' ? [id, ...flags].filter((value): value is string => value !== undefined) : argv.slice(2);
    const options = parseInboxQueryOptions(args);
    if (subcommand !== 'thread' && options.reference !== undefined)
      throw new Error(`unexpected inbox argument: ${options.reference}`);
    if (hasWorkerIdentityMarkers(process.env)) throw new Error('workers cannot read the shared manager inbox');
    if (!authenticatedCallingManager(runtime))
      throw new Error('shared inbox reads require an authenticated manager session');
    if (subcommand === 'log') printInboxResult(sharedInbox.log(options), options.json);
    else if (subcommand === 'thread') {
      const reference = options.reference;
      if (!reference) throw new Error('usage: inbox thread <id|task> [--limit <n>] [--cursor <id>] [--json]');
      printInboxResult(
        sharedInbox.thread(reference, {
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        }),
        options.json,
      );
    } else {
      if (options.since === undefined)
        throw new Error('usage: inbox digest --since <time> [--limit <n>] [--cursor <id>] [--json]');
      printInboxResult(
        sharedInbox.digest(options.since, {
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        }),
        options.json,
      );
    }
  } else {
    if (!id) throw new Error(`usage: inbox ${subcommand} <manager>`);
    await recordManagerCommand(runtime);
    if (subcommand === 'wait') {
      const at = flags.indexOf('--settle');
      const settle = at < 0 ? 0 : Number(flags[at + 1]);
      if (!Number.isFinite(settle) || settle < 0) throw new Error('usage: inbox wait <manager> [--settle <seconds>]');
      console.log(JSON.stringify(await inbox.wait(id, undefined, settle * 1000)));
    } else if (subcommand === 'read') {
      const owner = !hasWorkerIdentityMarkers(process.env) ? authenticatedCallingManager(runtime) : undefined;
      const options = parseInboxReadOptions(flags);
      const page =
        owner?.id === id && isResidentSupermanagerRecord(runtime, id)
          ? inbox.readResidentPage(id, owner.sessionId, options)
          : inbox.readPage(id, options);
      console.log(JSON.stringify(page));
    } else if (subcommand === 'ack') inbox.acknowledge(id, flags.length ? flags.map(Number) : undefined);
    else throw new Error(`unknown inbox command: ${subcommand ?? '(missing)'}`);
  }
  return 0;
}

function parseInboxReadOptions(args: string[]): { limit?: number; cursor?: number } {
  const options: { limit?: number; cursor?: number } = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    const value = args[++index];
    if ((option !== '--limit' && option !== '--cursor') || !value || value.startsWith('--'))
      throw new Error('usage: inbox read <manager> [--limit <n>] [--cursor <id>]');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`inbox ${option} must be a positive integer`);
    if (option === '--limit') {
      if (options.limit !== undefined) throw new Error('duplicate inbox option: --limit');
      options.limit = parsed;
    } else {
      if (options.cursor !== undefined) throw new Error('duplicate inbox option: --cursor');
      options.cursor = parsed;
    }
  }
  return options;
}

function parseInboxQueryOptions(args: string[]): InboxCliOptions {
  const options: InboxCliOptions = { json: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    if (!option.startsWith('--')) {
      if (options.reference !== undefined) throw new Error(`unexpected inbox argument: ${option}`);
      options.reference = option;
      continue;
    }
    if (seen.has(option)) throw new Error(`duplicate inbox option: ${option}`);
    seen.add(option);
    if (option === '--json') {
      options.json = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for inbox option ${option}`);
    switch (option) {
      case '--from':
        options.from = value;
        break;
      case '--to':
        options.to = value;
        break;
      case '--goal':
        options.goal = value;
        break;
      case '--task':
        options.task = value;
        break;
      case '--since':
        options.since = value;
        break;
      case '--grep':
        options.grep = value;
        break;
      case '--limit':
        options.limit = Number(value);
        if (!Number.isSafeInteger(options.limit) || options.limit < 1)
          throw new Error('inbox --limit must be a positive integer');
        break;
      case '--cursor':
        options.cursor = Number(value);
        if (!Number.isSafeInteger(options.cursor) || options.cursor < 1)
          throw new Error('inbox --cursor must be a positive integer');
        break;
      default:
        throw new Error(`unknown inbox query option: ${option}`);
    }
  }
  return options;
}

function hasWorkerIdentityMarkers(env: NodeJS.ProcessEnv): boolean {
  return env.GOAL_TASK_ID !== undefined || env.GOAL_ATTEMPT !== undefined;
}

function resolveInboxSender(runtime: InboxCommandRuntime): ResolvedInboxSender {
  const env = process.env;
  if (hasWorkerIdentityMarkers(env)) return resolveWorkerInboxSender(runtime, env);
  const hasProviderIdentity = Boolean(env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID);
  const authenticated = authenticatedCallingManager(runtime, env);
  if (authenticated) return { from: authenticated.id, managerId: authenticated.id, sessionId: authenticated.sessionId };
  if (hasProviderIdentity) throw new Error('inbox sender identity does not match an authenticated manager session');
  throw new Error('inbox send requires an authenticated manager session');
}

function resolveWorkerInboxSender(runtime: InboxCommandRuntime, env: NodeJS.ProcessEnv): ResolvedInboxSender {
  const taskId = env.GOAL_TASK_ID;
  const attemptText = env.GOAL_ATTEMPT;
  if (!taskId || taskId.trim() !== taskId || !attemptText || !/^[1-9]\d*$/.test(attemptText))
    throw new Error('worker inbox sender requires a valid task and attempt identity');
  const attempt = Number(attemptText);
  if (!Number.isSafeInteger(attempt)) throw new Error('worker inbox sender requires a valid task and attempt identity');

  const taskTables = runtime.db
    .query(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('worker_tasks', 'worker_attempts')",
    )
    .get() as { count: number };
  if (taskTables.count !== 2) throw new Error('worker inbox sender has no persisted task fence');

  // Apply the control plane's current-attempt and cancellation fence before reading source ownership.
  runtime.fence.assertCurrent({ taskId, attempt });
  const row = runtime.db
    .query(`SELECT task.current_attempt, task.body AS task_body, attempt.body AS attempt_body
      FROM worker_tasks AS task JOIN worker_attempts AS attempt
        ON attempt.task_id = task.id AND attempt.attempt = ?
      WHERE task.id = ?`)
    .get(attempt, taskId) as {
    current_attempt: number;
    task_body: string;
    attempt_body: string;
  } | null;
  if (!row) throw new Error('worker inbox sender is not a persisted task attempt');

  let task: { id?: unknown; currentAttempt?: unknown; state?: unknown; brief?: { manager?: unknown } };
  let sourceAttempt: { taskId?: unknown; attempt?: unknown; state?: unknown };
  try {
    task = JSON.parse(row.task_body) as typeof task;
    sourceAttempt = JSON.parse(row.attempt_body) as typeof sourceAttempt;
  } catch {
    throw new Error('worker inbox sender has malformed persisted task data');
  }
  const ownerManager = task.brief?.manager;
  if (
    task.id !== taskId ||
    task.currentAttempt !== attempt ||
    row.current_attempt !== attempt ||
    sourceAttempt.taskId !== taskId ||
    sourceAttempt.attempt !== attempt ||
    sourceAttempt.state !== 'running' ||
    (task.state !== 'running' && task.state !== 'held') ||
    typeof ownerManager !== 'string' ||
    !ownerManager.trim()
  )
    throw new Error('worker inbox sender is not the current running task attempt');

  return {
    from: `worker:${taskId}/${attempt}`,
    managerId: ownerManager,
    worker: { kind: 'worker', taskId, attempt, ownerManager },
  };
}

function parseDocumentReference(value: string): InboxDocumentReference {
  let parsed: unknown = value;
  if (value.trimStart().startsWith('{')) {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error('inbox --document must be a path or a JSON document reference');
    }
  }
  if (typeof parsed === 'string') {
    if (!parsed.trim() || /[\r\n]/.test(parsed)) throw new Error('inbox --document path must be one line');
    return { path: parsed };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('inbox --document must be a path or a JSON document reference');
  const reference = parsed as Record<string, unknown>;
  if (
    Object.keys(reference).some((key) => key !== 'path' && key !== 'change') ||
    typeof reference.path !== 'string' ||
    !reference.path.trim() ||
    (reference.change !== undefined && (typeof reference.change !== 'string' || /[\r\n]/.test(reference.change)))
  )
    throw new Error('inbox --document JSON must contain a nonempty path and optional one-line change');
  return { path: reference.path, ...(typeof reference.change === 'string' ? { change: reference.change } : {}) };
}

function parseEscalation(value: string): InboxEscalation {
  let parsed: unknown = value;
  if (value.trimStart().startsWith('{')) {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error('inbox --escalation must be a reason or a JSON escalation object');
    }
  }
  if (typeof parsed === 'string') {
    if (!parsed.trim() || /[\r\n]/.test(parsed)) throw new Error('inbox --escalation reason must be one line');
    return { reason: parsed };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('inbox --escalation must be a reason or a JSON escalation object');
  const escalation = parsed as Record<string, unknown>;
  if (
    Object.keys(escalation).some((key) => key !== 'reason' && key !== 'target') ||
    typeof escalation.reason !== 'string' ||
    !escalation.reason.trim() ||
    /[\r\n]/.test(escalation.reason) ||
    (escalation.target !== undefined && (typeof escalation.target !== 'string' || !escalation.target.trim()))
  )
    throw new Error('inbox --escalation JSON must contain a reason and optional target');
  return { reason: escalation.reason, ...(typeof escalation.target === 'string' ? { target: escalation.target } : {}) };
}

function printInboxResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  if (value && typeof value === 'object' && 'entries' in value && Array.isArray(value.entries)) {
    const page = value as {
      entries: {
        id: number;
        from: string | null;
        to: string;
        goal: string | null;
        task: string | null;
        kind: string | null;
        summary: string | null;
      }[];
      hasMore: boolean;
      nextCursor: number | null;
    };
    for (const entry of page.entries)
      console.log(
        `#${entry.id} ${entry.kind ?? 'unknown'} Goal=${entry.goal ?? 'unknown'} task=${entry.task ?? 'unknown'} ${entry.from ?? 'unknown'} -> ${entry.to}: ${entry.summary ?? 'unknown summary'}`,
      );
    if (page.hasMore) console.log(`More results: continue with --cursor ${page.nextCursor}`);
    if (!page.entries.length) console.log('No inbox messages.');
    return;
  }
  if (
    value &&
    typeof value === 'object' &&
    'groups' in value &&
    Array.isArray(value.groups) &&
    'details' in value &&
    typeof value.details === 'object' &&
    value.details !== null
  ) {
    const digest = value as {
      since: number;
      groups: { goal: string | null; counts: Record<string, number> }[];
      details: {
        entries: { id: number; category: string; goal: string | null; summary: string | null }[];
        hasMore: boolean;
        nextCursor: number | null;
      };
    };
    console.log(`Inbox digest since ${new Date(digest.since).toISOString()}`);
    for (const group of digest.groups)
      console.log(
        `Goal=${group.goal ?? 'unknown'} ${Object.entries(group.counts)
          .map(([name, count]) => `${name}=${count}`)
          .join(' ')}`,
      );
    for (const entry of digest.details.entries)
      console.log(
        `#${entry.id} ${entry.category} Goal=${entry.goal ?? 'unknown'}: ${entry.summary ?? 'unknown summary'}`,
      );
    if (digest.details.hasMore) console.log(`More results: continue with --cursor ${digest.details.nextCursor}`);
    return;
  }
  console.log(JSON.stringify(value));
}
