import type { AgentAdapter, AgentLaunchOptions, AgentEvent } from '../agents.ts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { tokens, textSignals, parseExitObject } from './shared.ts';
import type { Profile } from '../types.ts';
import { parseClaudeUsage, readClaudeUsage, recordClaudeRateLimit } from './claude-usage.ts';

export { parseClaudeUsage, readClaudeUsage, recordClaudeRateLimit };

export const claudeAdapter: AgentAdapter = {
  supportsConsultation() {
    return false;
  },
  environmentKeys: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  cli: 'claude',
  canResume: true,
  streamsLog: true,
  start(options) {
    return command(options);
  },
  resume(options) {
    return command({ ...options, resumeSession: options.session });
  },
  signals: textSignals,
  canImport: false,
  readAllowance: readClaudeUsage,
  parseEvent: claudeEvent,
  parseExit: parseExitObject,
  sessionId(event) {
    return (event.type === 'system' && event.subtype === 'init') || event.type === 'result'
      ? (event.session_id ?? event.sessionId ?? null)
      : null;
  },
  isRateLimit(event) {
    return event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected';
  },
  matchesEvent(event) {
    return (
      event.type === 'system' ||
      event.type === 'assistant' ||
      event.type === 'result' ||
      event.type === 'rate_limit_event'
    );
  },
  environment(pool, env) {
    return resolve(pool.configDirectory) === join(homedir(), '.claude')
      ? env
      : { ...env, CLAUDE_CONFIG_DIR: pool.configDirectory };
  },
  afterExit(pool, log) {
    recordClaudeRateLimit(pool, log);
  },
  parseUsage() {
    return null;
  },
  pinProfile: pinnedClaudeProfile,
  failure(event) {
    return event.type === 'result' && event.is_error === true ? String(event.result ?? 'Claude turn failed') : null;
  },
  completed() {
    return false;
  },
};
function command(options: AgentLaunchOptions): [string, string[]] {
  const { profile, pool, prompt } = options;
  return [
    pool.command,
    [
      '-p',
      '--model',
      profile.model,
      '--effort',
      profile.effort,
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(options.resumeSession ? ['--resume', options.resumeSession] : []),
      '--strict-mcp-config',
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      ...(options.research ? ['--allowedTools', 'WebSearch'] : []),
      '--',
      prompt,
    ],
  ];
}

function pinnedClaudeProfile(model: string, requestedEffort: string | undefined, route: Profile): Profile {
  if (!/^claude-[a-z0-9.-]+$/.test(model)) throw new Error(`brief model must be a Claude model: ${model}`);
  const effort = (requestedEffort ?? route.effort) as Profile['effort'];
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`invalid brief effort: ${effort}`);
  return {
    cli: 'claude' as const,
    model,
    effort,
    poolClass: 'claude',
    ...(route.serviceTier ? { serviceTier: route.serviceTier } : {}),
  };
}

function claudeEvent(event: Record<string, any>, hasRollout: boolean): AgentEvent | null {
  const result: AgentEvent = {};
  if (event.type === 'assistant')
    result.commands = (event.message?.content ?? [])
      .filter((call: Record<string, any>) => call?.type === 'tool_use' && typeof call.input?.command === 'string')
      .map((call: Record<string, any>) => ({ ...(call.id ? { id: call.id } : {}), text: call.input.command }));
  if (event.type === 'assistant')
    result.steps = (event.message?.content ?? [])
      .filter((call: Record<string, any>) => call?.type === 'tool_use')
      .map((call: Record<string, any>) => {
        const input = call.input?.command ?? call.input ?? '';
        return {
          ...(call.id ? { id: call.id } : {}),
          name: call.name ?? 'tool_use',
          input: typeof input === 'string' ? input : JSON.stringify(input),
        };
      });
  if (event.type === 'result') {
    if (!hasRollout && event.usage) result.usage = { tokens: tokens(event.usage), delta: event.usage_mode === 'delta' };
    if (event.result !== undefined)
      result.answer = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
    result.final = true;
  }
  return Object.keys(result).length ? result : null;
}
