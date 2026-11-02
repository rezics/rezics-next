import type { AgentAdapter, AgentLaunchOptions } from '../agents.ts';
import { tokens, textSignals, parseExitObject } from './shared.ts';
import type { Cli } from '../types.ts';

export function passthroughAdapter(cli: 'grok' | 'cursor'): AgentAdapter {
  return {
    supportsConsultation() {
      return false;
    },
    environmentKeys: cli === 'grok' ? ['GROK_HOME', 'GROK_CONFIG_DIR'] : ['CURSOR_CONFIG_DIR'],
    cli,
    canResume: false,
    streamsLog: false,
    signals: textSignals,
    canImport: true,
    start(options) {
      return command(cli, options);
    },
    resume(options) {
      const { resumeSession: _resumeSession, ...freshOptions } = options;
      return command(cli, freshOptions);
    },
    parseEvent(event, hasRollout) {
      if (
        event.type === 'error' ||
        (event.type !== 'result' &&
          event.result === undefined &&
          !(event.text !== undefined && event.stopReason !== undefined))
      )
        return null;
      const answer = event.result ?? event.text;
      return {
        ...(answer !== undefined ? { answer: typeof answer === 'string' ? answer : JSON.stringify(answer) } : {}),
        ...(!hasRollout && event.usage
          ? { usage: { tokens: tokens(event.usage), delta: event.usage_mode === 'delta' } }
          : {}),
        final: event.type === 'result',
      };
    },
    parseExit: parseExitObject,
    sessionId(event) {
      return typeof event.thread_id === 'string'
        ? event.thread_id
        : typeof event.session_id === 'string'
          ? event.session_id
          : typeof event.sessionId === 'string'
            ? event.sessionId
            : typeof event.payload?.id === 'string'
              ? event.payload.id
              : typeof event.payload?.session_id === 'string'
                ? event.payload.session_id
                : null;
    },
    isRateLimit(event) {
      const text =
        event.type === 'error'
          ? (event.error?.message ?? event.message ?? event.result ?? '')
          : (event.error?.message ?? event.result ?? '');
      return /usage limit|rate limit|quota exhausted/i.test(String(text));
    },
    matchesEvent(event) {
      return Boolean(
        event.thread_id || event.session_id || event.sessionId || event.type === 'result' || event.type === 'error',
      );
    },
    environment(pool, env) {
      return { ...env, [cli === 'grok' ? 'GROK_HOME' : 'CURSOR_CONFIG_DIR']: pool.configDirectory };
    },
    afterExit() {},
    parseUsage() {
      return null;
    },
    failure(event) {
      if (event.type === 'error')
        return String(event.error?.message ?? event.message ?? event.result ?? 'Agent turn failed');
      return event.type === 'result' && (event.is_error === true || event.error)
        ? String(event.error?.message ?? event.result ?? 'Agent turn failed')
        : null;
    },
    completed(event) {
      return event.type === 'result' && event.is_error !== true && !event.error;
    },
  };
}
function command(cli: Cli, options: AgentLaunchOptions): [string, string[]] {
  const { profile, pool, worktree, prompt } = options;
  if (cli === 'grok')
    return [
      pool.command,
      [
        '-m',
        profile.model,
        '--reasoning-effort',
        profile.effort,
        '--permission-mode',
        'bypassPermissions',
        '--no-subagents',
        '--output-format',
        'json',
        '--cwd',
        worktree,
        `--single=${prompt}`,
      ],
    ];
  return [
    pool.command,
    [
      '-p',
      '--model',
      `${profile.model}-${profile.effort}`,
      '--force',
      '--trust',
      '--sandbox',
      'disabled',
      '--output-format',
      'json',
      '--workspace',
      worktree,
      '--',
      prompt,
    ],
  ];
}
