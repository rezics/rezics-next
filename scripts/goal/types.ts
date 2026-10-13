import { join } from 'node:path';
import { homedir } from 'node:os';

export type State = 'running' | 'exited' | 'conflict' | 'merged' | 'stopped' | 'verified' | 'cancelled';
export type Engine = 'claude' | 'sonnet' | 'haiku' | 'fable' | 'sol' | 'codex' | 'codex-1' | 'luna' | 'grok' | 'cursor';
export const BRIEF_KINDS = ['outcome', 'implementation', 'surface', 'mechanism', 'tooling'] as const;
export type BriefKind = typeof BRIEF_KINDS[number];
export interface Brief {
  id: string; title: string; effort: string; engine?: Engine; cases: string[]; paths: string[];
  migrations: string[]; shared: string[]; depends: string[];
  /** Repository files required on main before the first dispatch. */
  needs?: string[];
  kind?: BriefKind; rows?: string[];
  /** Explicit proofs run together by the worker check command. */
  tests?: string[];
  /** Files staged under .temp/ref before the worker starts. */
  refs?: string[];
  /** Queries resolved by the API operation index for the initial prompt. */
  operations?: string[];
  /** A shared worktree name within a Goal: its tasks work concurrently in one tree and branch. */
  worktree?: string;
  /** Opt in to review, merge and close when the worker's waiter sees a done handoff. */
  land?: 'auto';
}
export interface Attempt {
  n: number; effort: string; engine?: Engine; pid: number; session: string; output: string; lastMessage?: string;
  startedAt: string; endedAt?: string;
  /** A partial handoff advances a landed or clean read-only step; only fixes consume the two rounds. */
  round?: 'initial' | 'step' | 'fix' | 'continuation';
  /** Why settlement continued an ended worker attempt without a manager resume. */
  continuedFor?: 'transport' | 'capacity' | 'handoff';
}
export interface Task extends Omit<Brief, 'worktree'> {
  brief: string; worktree: string; branch: string; base: string; state: State; attempts: Attempt[];
  /** Set when the task works in a shared worktree. */
  worktreeName?: string;
  mergedCommit?: string; closedAt?: string;
  /** The Goal that owns the task. Tasks dispatched before several Goals ran at once have none. */
  goal?: string;
  /** Merge refuses files and lines that name tasks (`historyIntroductions`). Unset on tasks dispatched before
   * 2026-10-04, whose briefs still asked for task-named tests. */
  historyGate?: boolean;
  /** Normalized migration paths retain the original claim when a failed unit gate is retried. */
  migrationOrigins?: Record<string, string>;
  /** Files another open task claims that its Goal's manager (or the program) lent to this task (`loan`). */
  loans?: string[];
  /** First line of the message that put the task in `conflict`. Absent in every other state. */
  refusal?: string;
  /** One durable settlement claim for the latest worker attempt. */
  settlement?: {
    attempt: number; token: string;
    owner: { pid: number; start?: string; boot?: string };
    settledAt?: string; reason?: string;
  };
}
/** One running Goal. Its intent and areas live in `docs/goals/<slug>/GOAL.md`; the ledger keeps only runtime state. */
export interface GoalRecord { manager: string; startedAt: string; closedAt?: string; archive?: string }
export interface Ledger {
  startedAt?: string;
  /** The single manager of the ledger's first Goal; GoalRecord.manager replaces it. */
  manager?: string;
  goals?: Record<string, GoalRecord>;
  /** IDs handed out by `new` and not yet dispatched, with the Goal each belongs to. */
  reserved?: Record<string, string>;
  /** The highest ID ever used, so IDs stay unique after closed Goals leave the ledger. */
  lastId?: number;
  tasks: Record<string, Task>;
}
export interface UsageWindow { used_percentage?: number; resets_at?: string | number }
export interface UsageSnapshot {
  at?: number; rate_limits?: { five_hour?: UsageWindow | null; seven_day?: UsageWindow | null } | null;
}
export interface UsageSample { at: number; used: number; resets: number; week?: number; weekResets?: number }
export type UsageLevel = 'unknown' | 'normal' | 'restricted' | 'critical';
export interface UsageReport {
  level: UsageLevel; used?: number; ageSeconds?: number; resetInMinutes?: number;
  ratePerHour?: number; projected?: number; weekUsed?: number; weekProjected?: number; weekProjectedHigh?: number;
  weekResetInHours?: number; weekAdvice?: string; reason?: string;
}
export interface AccountUsage {
  account: string; home: string; engines: Engine[]; used?: number; windowMinutes?: number;
  weekUsed?: number;
  resetInHours?: number; windowResetsAt?: number; sampledAt?: number; plan?: string; reached?: boolean; ageSeconds?: number;
}
export interface CodexResetStatus {
  data?: {
    latest_reset?: { announced_at?: string } | null;
    stats?: { avg_interval_days?: number } | null;
  };
}
export interface CodexResetLoad { status?: CodexResetStatus; fetchedAt?: number; available: boolean }

// Worker engines and the efforts each CLI and model accepts. Which engine and effort a task gets is
// the manager's decision from the need and the remaining usage (docs/goals/manager.md), not a rule here.
export const MODEL = 'claude-opus-5-5';
// Fable runs through Claude Code. Its weekly allowance may be its own, but it shares the Claude 5h session
// limit (both hit 'session limit' together on 2026-09-28), so the 5h gate applies to it as to Opus.
export const FABLE_MODEL = 'claude-fable-5-1';
// Sonnet runs through Claude Code on the same subscription, so the Claude usage gate applies to it too.
// Claude Code 2.1.284 is the first release here that accepts claude-sonnet-5-5 (2.1.283 rejected it).
export const SONNET_MODEL = process.env.GOAL_SONNET_MODEL ?? 'claude-sonnet-5-5';
// Haiku 5.5 takes bounded mechanical work (what Luna took) on the Claude subscription, so that work does not
// spend a Codex account. Tried on 2026-10-12 with --effort high and max.
export const HAIKU_MODEL = process.env.GOAL_HAIKU_MODEL ?? 'claude-haiku-5-5';
// GPT-6.1 Sol replaced GPT-6 Sol and GPT-6 Astra on 2026-09-30 (maintainer).
export const CODEX_MODEL = 'gpt-6.1-sol';
export const LUNA_MODEL = 'gpt-6-luna';
export const GROK_MODEL = 'grok-4.7';
// GOAL_CURSOR_MODEL names another Cursor model verbatim (for example `auto`) when the Grok allowance on Cursor is spent.
export const cursorModel = (effort: string): string => process.env.GOAL_CURSOR_MODEL ?? `${GROK_MODEL}-${effort}`;
const ENGINE_EFFORTS: Record<Engine, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  sonnet: ['low', 'medium', 'high', 'xhigh', 'max'],
  haiku: ['low', 'medium', 'high', 'xhigh', 'max'],
  fable: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  sol: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'codex-1': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  luna: ['low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['low', 'medium', 'high'],
  // Cursor Agent selects Grok 4.7 through per-effort model IDs (grok-4.7-<effort>).
  cursor: ['low', 'medium', 'high', 'xhigh'],
};
export const ENGINES = Object.keys(ENGINE_EFFORTS) as Engine[];
// The last line of an engine's error output that means the session's connection dropped. Cursor names
// every such exit RetriableError ("Connection stalled repeatedly", "HTTP/2 keepalive ping timed out").
// Quota, limit and authentication failures stay off this list, so those exits are left as they are.
export const TRANSPORT_ERRORS: readonly RegExp[] = [/^RetriableError: /];
export const MAX_TRANSPORT_CONTINUATIONS = 2;
// "Selected model is at capacity" ends a Codex turn with its session intact (four Sol sessions in twenty
// minutes on 2026-10-12, each waiting for a manager to resume it). Wait resumes the same session itself.
export const MAX_CAPACITY_CONTINUATIONS = 4;
export const CAPACITY_WAIT_MS = 30_000;
export const DEFAULT_ENGINE: Engine = (process.env.GOAL_ENGINE as Engine | undefined) ?? 'sol';
// `codex` (Sol) and `luna` use the default Codex account; `codex-1` runs Sol on the second account in a
// separate CODEX_HOME (the `codex-1` wrapper sets the same directory), so Sol work can continue on
// whichever account still has usage.
export const CODEX_HOME = process.env.GOAL_CODEX_HOME ?? join(homedir(), '.codex');
export const CODEX_1_HOME = process.env.GOAL_CODEX_1_HOME ?? join(homedir(), '.codex-1');
export const engineOf = (item: { engine?: Engine }): Engine => item.engine ?? 'claude';
export const MODELS: Record<Engine, string> = { claude: MODEL, sonnet: SONNET_MODEL, haiku: HAIKU_MODEL, fable: FABLE_MODEL, sol: CODEX_MODEL, codex: CODEX_MODEL, 'codex-1': CODEX_MODEL, luna: LUNA_MODEL,
  grok: GROK_MODEL, cursor: `${process.env.GOAL_CURSOR_MODEL ?? GROK_MODEL} (Cursor)` };
export const modelOf = (engine: Engine): string => MODELS[engine];
export const effortsOf = (engine: Engine): string[] => ENGINE_EFFORTS[engine] ?? [];
export const isCodex = (engine: Engine): boolean =>
  engine === 'codex' || engine === 'codex-1' || engine === 'luna';
export const isClaudeCode = (engine: Engine): boolean => engine === 'claude' || engine === 'sonnet' || engine === 'haiku' || engine === 'fable';
// Process name that /proc/<pid>/cmdline carries for a live worker of each engine.
export const programOf = (engine: Engine): string =>
  isCodex(engine) ? 'codex' : engine === 'cursor' ? 'cursor-agent' : isClaudeCode(engine) ? 'claude' : engine;
export const engineEnv = (engine: Engine): Record<string, string> =>
  engine === 'codex-1' ? { CODEX_HOME: CODEX_1_HOME } : isCodex(engine) ? { CODEX_HOME } : {};
export const HOLDING: State[] = ['running', 'exited', 'conflict', 'merged', 'stopped'];
// Landed (`merged`) and closed tasks no longer have to land. Every other holding state
// still does, including files it committed outside its claim.
export const UNLANDED: State[] = ['running', 'exited', 'conflict', 'stopped'];
