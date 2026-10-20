import { Database } from 'bun:sqlite';
import { failureClasses, type JobResultClass } from '../qa/failure.ts';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { configuredAccounts } from './config.ts';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Attempt, Ledger, Task } from './goalctl.ts';
import { handoffResult } from './land.ts';

type WakeCounts = Record<JobResultClass | 'unclassified', number>;
type AttemptCounts = { jobWake: WakeCounts; baselineRed: number; environment: number; unclassified: number; first: number; stepResume: number; fixRound: number; capacityRetry: number; transportRetry: number; handoffRetry: number };
type Refusals = { outcomeTest: number; gate: number; failingTestFinding: number; other: number };
type Tokens = { input: number; output: number };
export interface GoalMeasures {
  attempts: { run: AttemptCounts; today: AttemptCounts; inferredFixRounds: number };
  firstAttemptShare: { run: Share; today: Share };
  attemptsPerLanded: { tasks: Record<string, number>; median: number | null; largest: { task: string; attempts: number } | null };
  tokens: Tokens & { missingSessions: number; perProvedRow: 'n/a' };
  landingsRefused: Refusals;
  /** Today's first attempts are under half of ten or more: the fix rounds have a common cause to find. Never a reason to hold a new brief. */
  repeatsDominate: boolean;
}
type Share = { first: number; attempts: number; share: number | null };
interface AttemptLog { session?: string; handoff?: string; cumulative?: Tokens; incremental: Tokens }
interface LogEvent {
  type?: string; timestamp?: string; thread_id?: string; session_id?: string; sessionId?: string;
  result?: string; text?: string; usage?: Record<string, unknown>; item?: { type?: string; text?: string };
  payload?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } };
}
interface MeasureOptions {
  root?: string; nowMs?: number; codexHomes?: string[]; print?: (line: string) => void;
}
const counts = (): AttemptCounts => ({ jobWake: { passed: 0, assertion: 0, timeout: 0, environment: 0, harness: 0, unclassified: 0 },
  baselineRed: 0, environment: 0, unclassified: 0, first: 0, stepResume: 0, fixRound: 0, capacityRetry: 0, transportRetry: 0, handoffRetry: 0 });
const zero = (): Tokens => ({ input: 0, output: 0 });
const share = (c: AttemptCounts): Share => ({ first: c.first, attempts: c.first + c.fixRound,
  share: c.first + c.fixRound ? c.first / (c.first + c.fixRound) : null });
const number = (n: unknown): number => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
function tokens(usage: Record<string, unknown>, cache = false): Tokens {
  return { input: number(usage.input_tokens) + (cache ? number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens) : 0),
    output: number(usage.output_tokens) };
}
function add(to: Tokens, from: Tokens): void { to.input += from.input; to.output += from.output; }
function maximum(to: Tokens, from: Tokens): void { to.input = Math.max(to.input, from.input); to.output = Math.max(to.output, from.output); }
function read(path: string | undefined): string {
  try { return path ? readFileSync(path, 'utf8') : ''; } catch { return ''; }
}
async function events(path: string, visit: (event: LogEvent) => void): Promise<void> {
  if (!existsSync(path)) return;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; } // A live worker can leave a partial final line.
    if (event && typeof event === 'object') visit(event);
  }
}
async function attemptLog(attempt: Attempt, root: string): Promise<AttemptLog> {
  const log: AttemptLog = { session: attempt.session || undefined, handoff: read(attempt.lastMessage && resolve(root, attempt.lastMessage)), incremental: zero() };
  const lastMessage = log.handoff;
  const visit = (event: LogEvent) => {
    log.session ||= event.thread_id ?? event.session_id ?? event.sessionId;
    if (event.type === 'turn.completed' && event.usage) {
      log.cumulative ??= zero();
      maximum(log.cumulative, tokens(event.usage));
    } else if (event.usage) add(log.incremental, tokens(event.usage, true));
    const text = event.result ?? event.text ?? (event.item?.type === 'agent_message' ? event.item.text : undefined);
    if (!lastMessage && text) log.handoff = text;
  };
  const path = resolve(root, attempt.output);
  if (attempt.engine && (attempt.engine === 'luna' || configuredAccounts({ cwd: root }).some(account => account.engine === attempt.engine))) await events(path, visit);
  else { try { visit(JSON.parse(read(path)) as LogEvent); } catch { /* Unfinished or unavailable result. */ } }
  return log;
}
function refusalKind(text: string): keyof Refusals {
  const header = text.split('\n')[0]!;
  if (/blocking review findings/i.test(header)) return /(?:failing test|test.*fails?)/i.test(text) ? 'failingTestFinding' : 'other';
  if (/outcome.*(?:fail|skip|weaken|edit)|(?:fail|skip|weaken|edit).*outcome/i.test(header)) return 'outcomeTest';
  if (/introduced (?:type errors|unit failures)|(?:gate|type ?check|guards).*?(?:fail|refus|inconclusive)|(?:fail|refus).*?(?:gate|type ?check|guards)/i.test(header)) return 'gate';
  return 'other';
}
function refusals(task: Task, root: string): { counts: Refusals; times: number[] } {
  const result: Refusals = { outcomeTest: 0, gate: 0, failingTestFinding: 0, other: 0 };
  const stops: string[] = [];
  const times: number[] = [];
  for (const dir of new Set(task.attempts.map(a => dirname(resolve(root, a.output))))) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(n => /^review-\d+-/.test(n))) {
      const stop = read(join(dir, name, 'stop.txt')).trim();
      if (stop) { stops.push(stop); times.push(Number(/^review-(\d+)-/.exec(name)?.[1])); }
    }
  }
  // A conflict's first line can also be the most recent retained landing report.
  if (task.refusal && !stops.some(stop => stop.split('\n')[0] === task.refusal)) stops.push(task.refusal);
  for (const stop of stops) result[refusalKind(stop)]++;
  return { counts: result, times };
}
async function sessionGrowth(path: string, attempts: Attempt[], nowMs: number): Promise<Tokens | undefined> {
  const intervals = attempts.map(a => [Date.parse(a.startedAt), a.endedAt ? Date.parse(a.endedAt) : nowMs]);
  let previous = zero(), seen = false;
  const total = zero();
  await events(path, event => {
    const usage = event.payload?.type === 'token_count' && event.payload.info?.total_token_usage;
    if (!usage) return;
    const current = tokens(usage), at = Date.parse(event.timestamp ?? '');
    if (intervals.some(([start, end]) => at >= start! && at <= end!)) {
      // Tool progress can repeat the same cumulative counter.
      add(total, { input: Math.max(0, current.input - previous.input), output: Math.max(0, current.output - previous.output) });
      seen = true;
    }
    previous = current;
  });
  return seen ? total : undefined;
}

/** Read old job records without creating a database or migrating another worktree. */
function jobWakes(task: Task): Map<number, JobResultClass | undefined> {
  const results = new Map<number, JobResultClass | undefined>();
  const path = join(task.worktree, '.temp/goal/jobs/jobs.sqlite');
  if (!existsSync(path)) return results;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    for (const row of db.query('SELECT record FROM jobs').all() as { record: string }[]) {
      const job = JSON.parse(row.record) as { task: string; attempt: number; resumedAttempt?: number;
        phase: string; code?: number; resultClass?: JobResultClass };
      if (job.task !== task.id || (!job.resumedAttempt && job.phase !== 'woken')) continue;
      const result = job.code === 0 ? 'passed' : job.resultClass;
      results.set(job.resumedAttempt ?? job.attempt + 1,
        result === 'passed' || failureClasses.some(kind => kind === result) ? result : undefined);
    }
  } catch { /* Pruned, unavailable and older records remain visibly unclassified. */ }
  finally { db?.close(); }
  return results;
}

/** Read the existing ledger and session evidence; no counters or history are written. */
export async function goalMeasures(ledger: Ledger, options: MeasureOptions = {}): Promise<Record<string, GoalMeasures>> {
  const root = options.root ?? process.cwd(), nowMs = options.nowMs ?? Date.now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const homes = options.codexHomes ?? configuredAccounts({ cwd: root }).flatMap(account => account.home ? [account.home] : []);
  const native = new Map<string, string>();
  for (const home of homes) {
    if (!existsSync(home)) continue;
    for (const file of new Bun.Glob('sessions/**/rollout-*.jsonl').scanSync({ cwd: home })) {
      const id = /([\da-f]{8}-[\da-f-]{27})\.jsonl$/.exec(basename(file))?.[1];
      if (id) native.set(id, join(home, file));
    }
  }
  const report: Record<string, GoalMeasures> = {};
  for (const [goal, record] of Object.entries(ledger.goals ?? {})) {
    if (record.closedAt) continue;
    const measure: GoalMeasures = { attempts: { run: counts(), today: counts(), inferredFixRounds: 0 },
      firstAttemptShare: { run: share(counts()), today: share(counts()) },
      attemptsPerLanded: { tasks: {}, median: null, largest: null },
      tokens: { ...zero(), missingSessions: 0, perProvedRow: 'n/a' },
      landingsRefused: { outcomeTest: 0, gate: 0, failingTestFinding: 0, other: 0 }, repeatsDominate: false };
    const sessions = new Map<string, { attempts: Attempt[]; cumulative?: Tokens; incremental: Tokens }>();
    for (const task of Object.values(ledger.tasks).filter(t => t.goal === goal)) {
      let prior: AttemptLog | undefined;
      const refused = refusals(task, root);
      const wakes = jobWakes(task);
      for (const [index, attempt] of task.attempts.entries()) {
        const log = await attemptLog(attempt, root);
        const priorResult = handoffResult(prior?.handoff ?? '');
        const refusedBeforeResume = index > 0 && refused.times.some(at => at >= Date.parse(task.attempts[index - 1]!.startedAt)
          && at <= Date.parse(attempt.startedAt));
        const kind = attempt.continuedFor === 'capacity' ? 'capacityRetry'
          : attempt.continuedFor === 'transport' ? 'transportRetry' : attempt.continuedFor === 'handoff' ? 'handoffRetry' : index === 0 ? 'first'
          : attempt.continuedFor === 'job' || wakes.has(attempt.n) || priorResult === 'parked' ? 'jobWake'
          : attempt.resumeClass === 'sameScope' ? 'fixRound'
          : attempt.resumeClass ?? (!refusedBeforeResume && priorResult === 'partial' ? 'stepResume' : 'fixRound');
        const wakeResult = attempt.jobResult ?? wakes.get(attempt.n) ?? 'unclassified';
        // Legacy handoffs cannot establish a failure class; retain their conservative fix count visibly.
        if (kind === 'fixRound' && !priorResult && !refusedBeforeResume) measure.attempts.inferredFixRounds++;
        const increment = (counts: AttemptCounts) => {
          if (kind === 'jobWake') counts.jobWake[wakeResult]++;
          else counts[kind]++;
          if ((kind === 'fixRound' && !attempt.resumeClass) || (kind === 'jobWake' && wakeResult === 'unclassified')) counts.unclassified++;
        };
        increment(measure.attempts.run);
        if (new Date(attempt.startedAt).toISOString().slice(0, 10) === today) increment(measure.attempts.today);
        prior = log;
        const key = log.session ?? `${task.id}/${attempt.n}`;
        const session = sessions.get(key) ?? { attempts: [], incremental: zero() };
        session.attempts.push(attempt);
        if (log.cumulative) { session.cumulative ??= zero(); maximum(session.cumulative, log.cumulative); }
        add(session.incremental, log.incremental);
        sessions.set(key, session);
      }
      if (task.mergedCommit || ['merged', 'verified'].includes(task.state)) measure.attemptsPerLanded.tasks[task.id] = task.attempts.length;
      for (const kind of Object.keys(refused.counts) as (keyof Refusals)[]) measure.landingsRefused[kind] += refused.counts[kind];
    }
    for (const [id, session] of sessions) {
      const path = native.get(id);
      const growth = path ? await sessionGrowth(path, session.attempts, nowMs) : undefined;
      if (growth) add(measure.tokens, growth);
      else if (session.cumulative) add(measure.tokens, session.cumulative);
      else if (session.incremental.input || session.incremental.output) add(measure.tokens, session.incremental);
      else measure.tokens.missingSessions++;
    }
    const landed = Object.entries(measure.attemptsPerLanded.tasks).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    if (landed.length) {
      measure.attemptsPerLanded.median = (landed[Math.floor((landed.length - 1) / 2)]![1] + landed[Math.floor(landed.length / 2)]![1]) / 2;
      const largest = landed.at(-1)!;
      measure.attemptsPerLanded.largest = { task: largest[0], attempts: largest[1] };
    }
    measure.firstAttemptShare = { run: share(measure.attempts.run), today: share(measure.attempts.today) };
    measure.repeatsDominate = measure.firstAttemptShare.today.attempts >= 10 && (measure.firstAttemptShare.today.share ?? 1) < 0.5;
    report[goal] = measure;
    if (options.print) for (const line of measureLines(goal, measure)) options.print(line);
  }
  return report;
}

export function measureLines(goal: string, m: GoalMeasures): string[] {
  const percent = (s: Share) => s.share === null ? 'n/a' : `${Math.round(s.share * 100)}%`;
  const compact = (n: number) => n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1e3 ? `${Math.round(n / 100) / 10}k` : String(n);
  const largest = m.attemptsPerLanded.largest;
  const r = m.landingsRefused;
  const attempts = (a: AttemptCounts) => `${a.first} first, ${a.stepResume} step, ${a.fixRound} fix, ${a.baselineRed} baseline-red, ${a.environment} environment, `
    + `${a.capacityRetry} capacity, ${a.transportRetry} transport, ${a.handoffRetry} handoff; `
    + `job wakes ${Object.values(a.jobWake).reduce((sum, value) => sum + value, 0)} (`
    + Object.entries(a.jobWake).map(([kind, value]) => `${value} ${kind}`).join(', ') + `); ${a.unclassified} unclassified`;
  const line = `measures ${goal}: first-attempt ${percent(m.firstAttemptShare.run)} (${m.firstAttemptShare.run.first} of ${m.firstAttemptShare.run.attempts}; today ${percent(m.firstAttemptShare.today)}, ${m.firstAttemptShare.today.first} of ${m.firstAttemptShare.today.attempts}); `
    + `attempts/landed median ${m.attemptsPerLanded.median ?? 'n/a'}, max ${largest ? `${largest.attempts} (${largest.task})` : 'n/a'}; `
    + `tokens ${compact(m.tokens.input)} in, ${compact(m.tokens.output)} out${m.tokens.missingSessions ? ` (${m.tokens.missingSessions} sessions unavailable)` : ''}; tokens/proved row n/a; `
    + `attempts run: ${attempts(m.attempts.run)}; today: ${attempts(m.attempts.today)}; `
    + (m.attempts.inferredFixRounds ? `${m.attempts.inferredFixRounds} fixes inferred from unavailable handoffs; ` : '')
    + `refused ${r.outcomeTest} outcome, ${r.gate} gate, ${r.failingTestFinding} failing-test finding, ${r.other} other (retained reports)`;
  return [line, ...m.repeatsDominate ? [`REPEATS ${goal}: first-attempt share today ${percent(m.firstAttemptShare.today)} (${m.firstAttemptShare.today.first} of ${m.firstAttemptShare.today.attempts}); class today's fix rounds by cause and remove the commonest; keep dispatching every brief whose inputs are on main`] : []];
}
