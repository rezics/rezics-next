import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { stateDir as goalStateDir } from './ledger.ts';

const ACTIONS = ['read', 'wait', 'edit', 'test', 'think', 'subagent', 'commit', 'other'] as const;
const TURN_BUCKETS = ['1-3', '4-6', '7-12', '13+'] as const;
const KEYS = ['"token_count"', '"task_started"', 'tool_call"', '"function_call"', '"role":"user"'];
const READ = /(rg |grep |sed -n|cat |ls |head |tail |wc |find |nl |jq |git (show|diff|log|status|grep|ls-files|rev-parse|merge-base))/u;
const TEST = /task goal -- (test|check|selfgate)|goalctl\.ts test|bun test|typecheck|oxlint|ast-grep|task guards|docs:check|task gen\b|task test|task lint|--affected|playwright|task qa/u;
const EDIT = /apply_patch|\*\*\* Begin Patch|cat > |sed -i|perl -pi|writeFileSync/u;

type Action = typeof ACTIONS[number];
type TurnBucket = typeof TURN_BUCKETS[number];
type SessionRole = 'worker' | 'review' | 'other';

interface Step {
  turn: number;
  inputTokens: number;
  cachedInputTokens: number;
  actions: Action[];
}

interface Session {
  account: string;
  task?: string;
  kind: string;
  role: SessionRole;
  turns: number;
  firstAt: string;
  steps: Step[];
}

export interface EfficiencyTask {
  task: string;
  turns: number;
  steps: number;
  inputTokens: number;
  sessions: number;
}

interface EngineMeasure {
  sessions: number;
  turns: number;
  steps: number;
  inputTokens: number;
}

interface AccountMeasure {
  sessions: number;
  inputTokens: number;
}

export interface EfficiencyRecord {
  at: string;
  window: { since: string | null; until: string };
  sessions: { total: number; workers: number; landingReviews: number; other: number };
  byRole: Record<'worker' | 'landingReviews' | 'other', { sessions: number; inputTokens: number; inputShare: number }>;
  steps: number;
  tokens: { input: number; cachedInput: number; cachedShare: number; workerInput: number };
  byTurn: Record<TurnBucket, number>;
  byAction: Partial<Record<Action, number>>;
  noDecisionShare: number;
  byEngine: Record<string, EngineMeasure>;
  byAccount: Record<string, AccountMeasure>;
  taskStats: {
    tasks: number;
    oneTurnTasks: number;
    oneTurnMedianInput: number | null;
    thirteenTurnTasks: number;
    thirteenTurnInputShare: number;
  };
  longSessions: {
    over150: number;
    workers: number;
    workerInputShare: number;
    after150InputShare: number;
  };
  tasks: EfficiencyTask[];
}

export interface EfficiencyOptions {
  stateDirectory?: string;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
  print?: (line: string) => void;
  reportError?: (line: string) => void;
  reportDiagnostic?: (line: string) => void;
}

interface ParsedArgs {
  since?: string;
  until?: string;
  record: boolean;
  last: boolean;
  json: boolean;
}

interface TaskWork {
  sessions: Session[];
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

function actionFor(name: unknown, input: string): Action {
  if (name === 'wait' || name === 'write_stdin' || name === 'sleep') return 'wait';
  if (name === 'spawn_agent' || name === 'send_message' || name === 'followup_task'
    || name === 'list_agents' || name === 'close_agent' || name === 'wait_agent') return 'subagent';
  if (name !== 'exec' && name !== 'exec_command' && name !== 'shell' && name !== 'local_shell') return 'other';
  if (input.includes('write_stdin') && input.replaceAll(' ', '').includes('chars:""')) return 'wait';
  if (EDIT.test(input)) return 'edit';
  if (TEST.test(input)) return 'test';
  if (/git (add|commit)/u.test(input)) return 'commit';
  if (READ.test(input)) return 'read';
  return 'other';
}

function startTask(line: string): string | undefined {
  const match = /worktrees\/(g-\d+)/u.exec(line);
  return match?.[1]?.toUpperCase();
}

function messageKind(payload: Record<string, unknown>): string | undefined {
  if (payload.role !== 'user' || !Array.isArray(payload.content)) return undefined;
  const text = payload.content.map(item => item && typeof item === 'object'
    ? (item as Record<string, unknown>).text : undefined).filter((item): item is string => typeof item === 'string').join(' ').trim();
  if (!text || text.startsWith('# AGENTS.md') || text.startsWith('<')) return undefined;
  return text.slice(0, 70).replaceAll('\n', ' ');
}

function roleFor(session: Pick<Session, 'kind' | 'task'>): SessionRole {
  if (session.kind.startsWith('Review') || session.kind.startsWith('Several reviewers')) return 'review';
  return session.task ? 'worker' : 'other';
}

async function readSession(file: string, account: string, since: number, until: number): Promise<Session | undefined> {
  let task: string | undefined;
  let kind: string | undefined;
  let turns = 0;
  let firstAt = '';
  let pending: Action[] = [];
  const steps: Step[] = [];
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!task) task = startTask(line);
      if (!KEYS.some(key => line.includes(key))) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (!value || typeof value !== 'object') continue;
      const event = value as Record<string, unknown>;
      if (!firstAt && typeof event.timestamp === 'string') {
        firstAt = event.timestamp;
        const started = Date.parse(firstAt);
        if (!Number.isFinite(started) || started < since || started > until) return undefined;
      }
      const payload = event.payload && typeof event.payload === 'object'
        ? event.payload as Record<string, unknown> : {};
      const type = payload.type;
      if (type === 'task_started') turns++;
      else if (type === 'message' && kind === undefined) kind = messageKind(payload);
      else if (type === 'custom_tool_call' || type === 'function_call') {
        const input = payload.input || payload.arguments || '';
        pending.push(actionFor(payload.name, textValue(input)));
      } else if (type === 'token_count' && payload.info && typeof payload.info === 'object') {
        const info = payload.info as Record<string, unknown>;
        const usage = info.last_token_usage && typeof info.last_token_usage === 'object'
          ? info.last_token_usage as Record<string, unknown> : {};
        const uniqueActions = [...new Set(pending)].sort();
        steps.push({ turn: Math.max(turns, 1),
          inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
          cachedInputTokens: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0,
          actions: uniqueActions.length ? uniqueActions : ['think'] });
        pending = [];
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!steps.length) return undefined;
  const session: Session = { account, task, kind: kind ?? '?', turns: Math.max(turns, 1), firstAt, steps, role: 'other' };
  session.role = roleFor(session);
  return session;
}

function sessionHomes(env: NodeJS.ProcessEnv): Array<{ path: string; account: string }> {
  const configured = env.GOAL_CODEX_HOMES;
  const paths = configured === undefined
    ? [join(homedir(), '.codex'), join(homedir(), '.codex-1')]
    : configured.split(delimiter).filter(Boolean);
  return paths.map((path, index) => ({ path: resolve(path),
    account: basename(path).includes('codex-1') ? 'codex-1'
      : basename(path).includes('codex') ? 'codex' : index === 0 ? 'codex' : `codex-${index}` }));
}

async function collectSessions(homes: Array<{ path: string; account: string }>, since: number, until: number): Promise<{ sessions: Session[]; opened: number }> {
  const seen = new Set<string>();
  const sessions: Session[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  // Directories use local start dates; resumed sessions stay in their original file.
  const firstDay = Number.isFinite(since) ? new Date(since - dayMs).toISOString().slice(0, 10).replaceAll('-', '/') : '';
  const lastDay = new Date(until + dayMs).toISOString().slice(0, 10).replaceAll('-', '/');
  for (const home of homes) {
    const root = join(home.path, 'sessions');
    if (!existsSync(root)) continue;
    const days = [...new Bun.Glob('????/??/??').scanSync({ cwd: root, onlyFiles: false })]
      .filter(day => /^\d{4}\/\d{2}\/\d{2}$/u.test(day) && day >= firstDay && day <= lastDay).sort();
    const files = days.flatMap(day => [...new Bun.Glob('**/*.jsonl').scanSync({ cwd: join(root, day), onlyFiles: true })]
      .sort().map(file => join(day, file)));
    for (const relativeFile of files) {
      const file = join(root, relativeFile);
      if (seen.has(file)) continue;
      seen.add(file);
      const session = await readSession(file, home.account, since, until);
      if (session) sessions.push(session);
    }
  }
  return { sessions, opened: seen.size };
}

function engineFor(session: Session): string {
  const match = /\((gpt-[^)]*)\)/u.exec(session.kind);
  if (!match?.[1]) return '?';
  return match[1].includes('luna') ? 'luna' : 'sol';
}

function percent(value: number, total: number): number {
  const ratio = 100 * value / Math.max(total, 1);
  const floor = Math.floor(ratio);
  const fraction = ratio - floor;
  return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 ? floor + 1 : floor;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function makeRecord(sessions: Session[], at: string, since: string | null, until: string): EfficiencyRecord {
  const workers = sessions.filter(session => session.role === 'worker');
  const reviews = sessions.filter(session => session.role === 'review');
  const other = sessions.filter(session => session.role === 'other');
  const input = (items: Session[]) => items.reduce((sum, session) => sum
    + session.steps.reduce((sub, step) => sub + step.inputTokens, 0), 0);
  const cached = sessions.reduce((sum, session) => sum
    + session.steps.reduce((sub, step) => sub + step.cachedInputTokens, 0), 0);
  const workerInput = input(workers);
  const totalInput = input(sessions);
  const byTurn = Object.fromEntries(TURN_BUCKETS.map(bucket => [bucket, 0])) as Record<TurnBucket, number>;
  const byAction: Partial<Record<Action, number>> = {};
  const taskWork = new Map<string, TaskWork>();
  for (const session of workers) {
    if (session.task) {
      const work = taskWork.get(session.task) ?? { sessions: [] };
      work.sessions.push(session);
      taskWork.set(session.task, work);
    }
    for (const step of session.steps) {
      const weight = step.inputTokens / step.actions.length;
      for (const action of step.actions) byAction[action] = (byAction[action] ?? 0) + weight;
    }
  }
  for (const work of taskWork.values()) {
    let offset = 0;
    for (const session of [...work.sessions].sort((a, b) => a.firstAt.localeCompare(b.firstAt))) {
      for (const step of session.steps) {
        const turn = offset + step.turn;
        const bucket: TurnBucket = turn <= 3 ? '1-3' : turn <= 6 ? '4-6' : turn <= 12 ? '7-12' : '13+';
        byTurn[bucket] += step.inputTokens;
      }
      offset += session.turns;
    }
  }
  const byEngine: Record<string, EngineMeasure> = {};
  for (const engine of ['sol', 'luna']) {
    const items = workers.filter(session => engineFor(session) === engine);
    if (!items.length) continue;
    byEngine[engine] = { sessions: items.length, turns: items.reduce((sum, item) => sum + item.turns, 0),
      steps: items.reduce((sum, item) => sum + item.steps.length, 0), inputTokens: input(items) };
  }
  const accountNames = [...new Set(sessions.map(session => session.account))].sort();
  const byAccount: Record<string, AccountMeasure> = {};
  for (const account of accountNames) {
    const items = sessions.filter(session => session.account === account);
    byAccount[account] = { sessions: items.length, inputTokens: input(items) };
  }
  const taskTotals: EfficiencyTask[] = [];
  for (const [task, work] of taskWork) {
    taskTotals.push({ task, turns: work.sessions.reduce((sum, session) => sum + session.turns, 0),
      steps: work.sessions.reduce((sum, session) => sum + session.steps.length, 0),
      inputTokens: input(work.sessions), sessions: work.sessions.length });
  }
  const over150 = workers.filter(session => session.steps.length > 150);
  const after150Input = over150.reduce((sum, session) => sum
    + session.steps.slice(150).reduce((sub, step) => sub + step.inputTokens, 0), 0);
  const oneTurnTasks = taskTotals.filter(task => task.turns === 1);
  const thirteenTurnTasks = taskTotals.filter(task => task.turns >= 13);
  const record: EfficiencyRecord = {
    at,
    window: { since, until },
    sessions: { total: sessions.length, workers: workers.length, landingReviews: reviews.length,
      other: sessions.length - workers.length - reviews.length },
    byRole: {
      worker: { sessions: workers.length, inputTokens: workerInput, inputShare: percent(workerInput, totalInput) },
      landingReviews: { sessions: reviews.length, inputTokens: input(reviews), inputShare: percent(input(reviews), totalInput) },
      other: { sessions: other.length, inputTokens: input(other), inputShare: percent(input(other), totalInput) },
    },
    steps: sessions.reduce((sum, session) => sum + session.steps.length, 0),
    tokens: { input: totalInput, cachedInput: cached, cachedShare: percent(cached, totalInput), workerInput },
    byTurn,
    byAction,
    noDecisionShare: percent((byAction.wait ?? 0) + (byAction.test ?? 0) + (byAction.commit ?? 0), workerInput),
    byEngine,
    byAccount,
    taskStats: { tasks: taskTotals.length, oneTurnTasks: oneTurnTasks.length,
      oneTurnMedianInput: median(oneTurnTasks.map(task => task.inputTokens)),
      thirteenTurnTasks: thirteenTurnTasks.length,
      thirteenTurnInputShare: percent(thirteenTurnTasks.reduce((sum, task) => sum + task.inputTokens, 0), workerInput) },
    longSessions: { over150: over150.length, workers: workers.length,
      workerInputShare: percent(input(over150), workerInput), after150InputShare: percent(after150Input, workerInput) },
    tasks: taskTotals.sort((a, b) => b.inputTokens - a.inputTokens || a.task.localeCompare(b.task)).slice(0, 10),
  };
  return record;
}

function parseTime(value: string, flag: string): string {
  if (!/(?:Z|[+-]\d\d:\d\d)$/iu.test(value)) throw new Error(`${flag} needs a UTC timestamp with a timezone`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${flag} needs a valid UTC timestamp`);
  return new Date(time).toISOString();
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { record: false, last: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--record') parsed.record = true;
    else if (arg === '--last') parsed.last = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--since' || arg === '--until') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a UTC timestamp`);
      if (arg === '--since') parsed.since = parseTime(value, arg);
      else parsed.until = parseTime(value, arg);
    } else if (arg.startsWith('--since=')) parsed.since = parseTime(arg.slice('--since='.length), '--since');
    else if (arg.startsWith('--until=')) parsed.until = parseTime(arg.slice('--until='.length), '--until');
    else throw new Error(`Unknown efficiency argument: ${arg}`);
  }
  if (parsed.last && (parsed.record || parsed.since || parsed.until)) {
    throw new Error('--last cannot be combined with --record, --since, or --until');
  }
  return parsed;
}

function isRecord(value: unknown): value is EfficiencyRecord {
  return !!value && typeof value === 'object' && typeof (value as EfficiencyRecord).at === 'string'
    && !!(value as EfficiencyRecord).sessions && typeof (value as EfficiencyRecord).steps === 'number';
}

function readRecords(directory: string): EfficiencyRecord[] {
  const file = join(directory, 'efficiency.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch { return []; }
  });
}

function numberFormat(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}

function percentFormat(value: number): string { return `${numberFormat(value)}%`; }

function quantity(value: number, noun: string): string {
  return `${numberFormat(value)} ${noun}${value === 1 ? '' : 's'}`;
}

function formatRecord(record: EfficiencyRecord): string[] {
  const lines = [
    'Efficiency audit',
    `Window: ${record.window.since ?? 'all recorded sessions'} through ${record.window.until} (session start time, inclusive)`,
    `Sessions: ${record.sessions.total} total; ${record.sessions.workers} workers; ${record.sessions.landingReviews} landing reviews; ${record.sessions.other} other`,
    `Input by role: workers ${quantity(record.byRole.worker.sessions, 'session')}, ${numberFormat(record.byRole.worker.inputTokens)} tokens (${percentFormat(record.byRole.worker.inputShare)});`
      + ` landing reviews ${quantity(record.byRole.landingReviews.sessions, 'session')}, ${numberFormat(record.byRole.landingReviews.inputTokens)} tokens (${percentFormat(record.byRole.landingReviews.inputShare)});`
      + ` other ${quantity(record.byRole.other.sessions, 'session')}, ${numberFormat(record.byRole.other.inputTokens)} tokens (${percentFormat(record.byRole.other.inputShare)})`,
    `Steps: ${record.steps}`,
    `Input tokens: ${numberFormat(record.tokens.input)}; cached ${numberFormat(record.tokens.cachedInput)} (${percentFormat(record.tokens.cachedShare)})`,
    `Worker input by task turn: ${TURN_BUCKETS.map(bucket => `${bucket} ${percentFormat(percent(record.byTurn[bucket], record.tokens.workerInput))}`).join(', ')}`,
    `Worker input by step: ${ACTIONS.map(action => `${action === 'subagent' ? 'sub-agent' : action} ${percentFormat(percent(record.byAction[action] ?? 0, record.tokens.workerInput))}`).join(', ')}`,
    `No-decision steps (wait, test, commit): ${percentFormat(record.noDecisionShare)} of worker input`,
  ];
  const engineText = Object.entries(record.byEngine).map(([engine, value]) =>
    `${engine}: ${quantity(value.sessions, 'session')}, ${numberFormat(value.inputTokens)} tokens, ${numberFormat(value.turns ? value.inputTokens / value.turns : 0)} per turn`);
  lines.push(`Worker sessions by engine: ${engineText.length ? engineText.join('; ') : 'none'}`);
  const accountText = Object.entries(record.byAccount).map(([account, value]) =>
    `${account}: ${quantity(value.sessions, 'session')}, ${numberFormat(value.inputTokens)} tokens`);
  lines.push(`Sessions by account: ${accountText.length ? accountText.join('; ') : 'none'}`);
  lines.push(`Tasks: ${record.taskStats.tasks}; one-turn ${record.taskStats.oneTurnTasks}`
    + (record.taskStats.oneTurnMedianInput === null ? '' : ` (median ${numberFormat(record.taskStats.oneTurnMedianInput)} tokens)`)
    + `; 13+ turns ${record.taskStats.thirteenTurnTasks} (${percentFormat(record.taskStats.thirteenTurnInputShare)} of worker input)`);
  lines.push(`Sessions over 150 steps: ${record.longSessions.over150} of ${record.longSessions.workers} workers`
    + ` (${percentFormat(record.longSessions.workerInputShare)} of worker input; ${percentFormat(record.longSessions.after150InputShare)} after step 150)`);
  lines.push('Ten dearest tasks:');
  for (const [index, task] of record.tasks.entries()) {
    lines.push(`${index + 1}. ${task.task}: ${quantity(task.turns, 'turn')}, ${quantity(task.steps, 'step')}, ${numberFormat(task.inputTokens)} tokens`);
  }
  return lines;
}

function changed(previous: number | undefined, current: number, isPercent = false): string {
  if (previous === undefined) return `— → ${isPercent ? percentFormat(current) : numberFormat(current)} (new)`;
  const delta = current - previous;
  const shownDelta = isPercent ? `${delta > 0 ? '+' : ''}${numberFormat(delta)} pp`
    : `${delta > 0 ? '+' : ''}${numberFormat(delta)}`;
  const left = isPercent ? percentFormat(previous) : numberFormat(previous);
  const right = isPercent ? percentFormat(current) : numberFormat(current);
  return `${left} → ${right} (${shownDelta})`;
}

function formatComparison(previous: EfficiencyRecord | undefined, current: EfficiencyRecord): string[] {
  const lines = ['Last efficiency audit comparison',
    `Previous: ${previous?.at ?? 'none'}; last: ${current.at}`];
  const oldSessions = previous?.sessions;
  lines.push(`Sessions: total ${changed(oldSessions?.total, current.sessions.total)}; workers ${changed(oldSessions?.workers, current.sessions.workers)};`
    + ` landing reviews ${changed(oldSessions?.landingReviews, current.sessions.landingReviews)}; other ${changed(oldSessions?.other, current.sessions.other)}`);
  for (const role of ['worker', 'landingReviews', 'other'] as const) {
    const oldValue = previous?.byRole[role];
    const value = current.byRole[role];
    lines.push(`Role ${role === 'landingReviews' ? 'landing reviews' : role}: sessions ${changed(oldValue?.sessions, value.sessions)};`
      + ` tokens ${changed(oldValue?.inputTokens, value.inputTokens)}; share ${changed(oldValue?.inputShare, value.inputShare, true)}`);
  }
  lines.push(`Steps: ${changed(previous?.steps, current.steps)}`);
  lines.push(`Input tokens: ${changed(previous?.tokens.input, current.tokens.input)}; cached ${changed(previous?.tokens.cachedInput, current.tokens.cachedInput)}`);
  lines.push(`Cached input share: ${changed(previous?.tokens.cachedShare, current.tokens.cachedShare, true)}; worker input ${changed(previous?.tokens.workerInput, current.tokens.workerInput)}`);
  lines.push(`Task-turn shares: ${TURN_BUCKETS.map(bucket => `${bucket} ${changed(previous ? percent(previous.byTurn[bucket], previous.tokens.workerInput) : undefined,
    percent(current.byTurn[bucket], current.tokens.workerInput), true)}`).join('; ')}`);
  lines.push(`Step-action shares: ${ACTIONS.map(action => `${action === 'subagent' ? 'sub-agent' : action} ${changed(
    previous ? percent(previous.byAction[action] ?? 0, previous.tokens.workerInput) : undefined,
    percent(current.byAction[action] ?? 0, current.tokens.workerInput), true)}`).join('; ')}`);
  lines.push(`No-decision share (wait, test, commit): ${changed(previous?.noDecisionShare, current.noDecisionShare, true)}`);
  for (const engine of ['sol', 'luna']) {
    const oldValue = previous?.byEngine[engine];
    const value = current.byEngine[engine];
    lines.push(`Engine ${engine}: sessions ${changed(oldValue?.sessions, value?.sessions ?? 0)}; turns ${changed(oldValue?.turns, value?.turns ?? 0)};`
      + ` steps ${changed(oldValue?.steps, value?.steps ?? 0)}; tokens ${changed(oldValue?.inputTokens, value?.inputTokens ?? 0)}`);
  }
  for (const account of ['codex', 'codex-1']) {
    const oldValue = previous?.byAccount[account];
    const value = current.byAccount[account];
    lines.push(`Account ${account}: sessions ${changed(oldValue?.sessions, value?.sessions ?? 0)}; tokens ${changed(oldValue?.inputTokens, value?.inputTokens ?? 0)}`);
  }
  lines.push(`Task breadth: tasks ${changed(previous?.taskStats.tasks, current.taskStats.tasks)}; one-turn ${changed(previous?.taskStats.oneTurnTasks, current.taskStats.oneTurnTasks)};`
    + ` median one-turn tokens ${changed(previous?.taskStats.oneTurnMedianInput ?? undefined, current.taskStats.oneTurnMedianInput ?? 0)};`
    + ` 13+ turns ${changed(previous?.taskStats.thirteenTurnTasks, current.taskStats.thirteenTurnTasks)} (${changed(
      previous?.taskStats.thirteenTurnInputShare, current.taskStats.thirteenTurnInputShare, true)} of worker input)`);
  lines.push(`Sessions over 150 steps: ${changed(previous?.longSessions.over150, current.longSessions.over150)};`
    + ` worker-input share ${changed(previous?.longSessions.workerInputShare, current.longSessions.workerInputShare, true)};`
    + ` after step 150 ${changed(previous?.longSessions.after150InputShare, current.longSessions.after150InputShare, true)}`);
  const oldTasks = new Map((previous?.tasks ?? []).map(task => [task.task, task]));
  const currentTasks = new Map(current.tasks.map(task => [task.task, task]));
  const allTasks = new Set([...oldTasks.keys(), ...currentTasks.keys()]);
  const taskNames = [...allTasks].sort((a, b) => Math.max(currentTasks.get(b)?.inputTokens ?? 0, oldTasks.get(b)?.inputTokens ?? 0)
    - Math.max(currentTasks.get(a)?.inputTokens ?? 0, oldTasks.get(a)?.inputTokens ?? 0) || a.localeCompare(b));
  lines.push('Top-task changes (sessions, turns, steps, tokens):');
  for (const task of taskNames) {
    const oldValue = oldTasks.get(task);
    const value = currentTasks.get(task);
    lines.push(`${task}: sessions ${changed(oldValue?.sessions, value?.sessions ?? 0)}; turns ${changed(oldValue?.turns, value?.turns ?? 0)};`
      + ` steps ${changed(oldValue?.steps, value?.steps ?? 0)};`
      + ` tokens ${changed(oldValue?.inputTokens, value?.inputTokens ?? 0)}`);
  }
  return lines;
}

function usageError(): string {
  return 'Usage: goalctl efficiency [--since <UTC time>] [--until <UTC time>] [--record] [--last] [--json]';
}

/** Measures Codex worker sessions locally and optionally appends a comparison record. */
export async function efficiencyCommand(args: string[], options: EfficiencyOptions = {}): Promise<number> {
  const print = options.print ?? console.log;
  const reportError = options.reportError ?? console.error;
  const stateDirectory = options.stateDirectory ?? goalStateDir;
  const now = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;
  let parsed: ParsedArgs;
  try { parsed = parseArgs(args); }
  catch (error) {
    reportError(error instanceof Error ? error.message : usageError());
    reportError(usageError());
    return 2;
  }
  if (parsed.last) {
    const records = readRecords(stateDirectory);
    const current = records.at(-1);
    if (!current) {
      if (parsed.json) print('null');
      else print('No efficiency records yet. Run goal efficiency --record first.');
      return 0;
    }
    if (parsed.json) print(JSON.stringify(current));
    else for (const line of formatComparison(records.at(-2), current)) print(line);
    return 0;
  }
  const previous = readRecords(stateDirectory).at(-1);
  const since = parsed.since ?? (previous ? parseTime(previous.at, '--since') : undefined);
  const until = parsed.until ?? new Date(now).toISOString();
  if (since && Date.parse(since) > Date.parse(until)) {
    reportError('--since must be no later than --until');
    return 2;
  }
  const { sessions, opened } = await collectSessions(sessionHomes(env), since === undefined ? -Infinity : Date.parse(since), Date.parse(until));
  if (since === undefined) (options.reportDiagnostic ?? console.error)(`Opened ${quantity(opened, 'session log')} (no lower time bound).`);
  const selected = sessions.filter(session => {
    const started = Date.parse(session.firstAt);
    return Number.isFinite(started) && started <= Date.parse(until)
      && (since === undefined || started >= Date.parse(since));
  });
  const record = makeRecord(selected, new Date(now).toISOString(), since ?? null, until);
  if (parsed.record) {
    mkdirSync(stateDirectory, { recursive: true });
    appendFileSync(join(stateDirectory, 'efficiency.jsonl'), `${JSON.stringify(record)}\n`);
  }
  if (parsed.json) print(JSON.stringify(record));
  else for (const line of formatRecord(record)) print(line);
  return 0;
}
