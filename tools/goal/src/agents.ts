import { AsyncLocalStorage } from 'node:async_hooks';
import type { Cli, Pool, PoolReading, Profile, Settings } from './types.ts';
import type { Tokens } from './types.ts';
import { codexAdapter } from './agents/codex.ts';
import { claudeAdapter } from './agents/claude.ts';
import { passthroughAdapter } from './agents/passthrough.ts';

export type AgentLaunchOptions = {
  profile: Profile;
  pool: Pool;
  worktree: string;
  prompt: string;
  readOnly?: boolean;
  research?: boolean;
  consultation?: boolean;
  /** A fresh train editing session; only adapters with supportsResolver may receive this mode. */
  resolver?: boolean;
  codex?: Settings['codex'];
  /** Streamable HTTP MCP servers this launch adds, such as the worktree's own Storybook. */
  mcpServers?: readonly McpServer[];
  resumeSession?: string;
};
export type McpServer = { name: string; url: string };
export type SessionUsage = {
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  reasoning: number;
  compactions: number;
};
export type AgentUsage = { tokens: Tokens; usage: SessionUsage; source?: 'codex-session' | 'attempt-profile' } | null;
export type AgentUsageAccumulator = {
  add(event: Record<string, any>): void;
  finish(): AgentUsage;
};
/** Provider events are normalized before the control plane accounts for them. */
export type AgentEvent = {
  usage?: { tokens: Tokens; delta: boolean };
  commands?: { id?: string; text: string }[];
  steps?: { id?: string; name: string; input: string }[];
  answer?: string;
  final?: boolean;
};
export type AgentAdapter = {
  readonly cli: Cli;
  readonly canResume: boolean;
  readonly streamsLog: boolean;
  readonly environmentKeys?: readonly string[];
  start(options: AgentLaunchOptions): [string, string[]];
  resume(options: AgentLaunchOptions & { session: string }): [string, string[]];
  /** start supports fresh train editing with workspace sandboxing and no network tools. */
  readonly supportsResolver?: boolean;
  hasRollout?(events: Record<string, any>[]): boolean;
  parseEvent?(event: Record<string, any>, hasRollout: boolean): AgentEvent | null;
  readSession?(configDirectory: string, session: string): string | null;
  readSessionPath?(configDirectory: string, session: string): string | null;
  readAllowance?(pool: Pool, now: number): PoolReading;
  signals?(text: string): { allowance: boolean; usageLimit: boolean; capacity: boolean };
  isUsageLimit?(event: Record<string, any>): boolean;
  pinProfile?(model: string, effort: string | undefined, route: Profile): Profile;
  supportsConsultation?(profile: Profile): boolean;
  readonly canImport?: boolean;
  readonly announcedReset?: boolean;
  parseExit(output: string): unknown | null;
  sessionId(event: Record<string, any>): string | null;
  isRateLimit(event: Record<string, any>): boolean;
  environment(pool: Pool, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  matchesEvent(event: Record<string, any>): boolean;
  afterExit(pool: Pool, log: string): void;
  parseUsage(events: Record<string, any>[], start: number, end: number): AgentUsage;
  createUsageAccumulator?(start: number, end: number): AgentUsageAccumulator;
  failure(event: Record<string, any>): string | null;
  completed(event: Record<string, any>): boolean;
};
const adapters: Record<Cli, AgentAdapter> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  grok: passthroughAdapter('grok'),
  cursor: passthroughAdapter('cursor'),
};
const overrides = new AsyncLocalStorage<AgentAdapter>();
/** Bind an adapter to one asynchronous worker lifecycle (also useful for embedded agents). */
export function withAgentAdapter<T>(adapter: AgentAdapter, run: () => T): T {
  return overrides.run(adapter, run);
}
export function isAgentCli(cli: unknown): cli is Cli {
  return typeof cli === 'string' && Object.hasOwn(adapters, cli);
}
/** Reporting classification belongs with provider identities, including unrecognized historical values. */
export function agentReportingEvidence(cli: unknown): { codex: boolean; unknown: boolean } {
  return { codex: cli === codexAdapter.cli, unknown: !isAgentCli(cli) };
}
export function cleanAgentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of agentEnvironmentKeys(env)) delete result[key];
  return result;
}
/** Provider-owned identities and config markers that a new process must not inherit from its launcher. */
export function agentEnvironmentKeys(env: NodeJS.ProcessEnv = {}): string[] {
  const keys = new Set<string>();
  for (const adapter of [...Object.values(adapters), ...allAgentAdapters()])
    for (const key of adapter.environmentKeys ?? []) keys.add(key);
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_')) keys.add(key);
  return [...keys];
}

/** Environment for a neutral Goal host or shared provider process; per-task authority is supplied separately. */
export function cleanManagedProviderEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = cleanAgentEnvironment(env);
  for (const key of ['GOAL_MANAGER', 'GOAL_TASK_ID', 'GOAL_ATTEMPT', 'GOAL_CHECK_WAIT_FILE']) delete result[key];
  return result;
}
export function agentAdapter(cli: Cli): AgentAdapter {
  const adapter = overrides.getStore();
  const selected = adapter?.cli === cli ? adapter : adapters[cli];
  if (!selected) throw new Error('unsupported worker CLI');
  return selected;
}
export function allAgentAdapters(): AgentAdapter[] {
  return Object.keys(adapters).map((cli) => agentAdapter(cli as Cli));
}
export function adaptersForEvent(event: Record<string, any>): AgentAdapter[] {
  return allAgentAdapters().filter((adapter) => adapter.matchesEvent(event));
}
export function parseAgentExit(output: string, selected?: AgentAdapter): unknown | null {
  for (const adapter of selected ? [selected] : allAgentAdapters()) {
    const parsed = adapter.parseExit(output);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Read command evidence without exposing a provider's event schema to monitors. */
export function agentCommands(output: string, adapter?: AgentAdapter): string[] {
  const candidates = adapter ? [adapter] : allAgentAdapters();
  const seen = new Set<string>();
  return output.split(/\r?\n/).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      const commands =
        candidates
          .map((candidate) => candidate.parseEvent?.(event, false)?.commands)
          .find((value) => value !== undefined) ?? [];
      return commands.flatMap((command) => {
        if (!command.text.trim() || (command.id && seen.has(command.id))) return [];
        if (command.id) seen.add(command.id);
        return [command.text.trim()];
      });
    } catch {
      return [];
    }
  });
}

/** The historical brief model pin selects its original adapter; routing policy remains compatible. */
export function pinnedModelProfile(model: string, effort: string | undefined, route: Profile): Profile {
  const pin = agentAdapter('codex').pinProfile ?? codexAdapter.pinProfile!;
  return pin(model, effort, route);
}

/** Original proofs use the normal Codex worker; provider eligibility belongs at this boundary. */
export function requireOriginalProofProfile(profile: Profile): void {
  if (profile.cli !== 'codex') throw new Error('verification requires the ordinary Codex worker route');
}
