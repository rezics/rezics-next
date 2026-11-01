import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { agentAdapter, type AgentAdapter, type AgentLaunchOptions } from '../agents.ts';
import { launchCommand } from '../launch.ts';
import type { Cli, Pool, Profile } from '../types.ts';
import { codexAdapter } from './codex.ts';

function options(cli: Cli = 'codex'): AgentLaunchOptions {
  const profile: Profile = { cli, model: 'gpt-6.1-sol', effort: 'high', poolClass: 'implementation' };
  const pool: Pool = {
    name: 'resolver-test', cli, command: 'unused-provider-command',
    configDirectory: join(import.meta.dir, '../../../../.temp/resolver-command-test-config'),
    classes: ['implementation'], allowanceKey: 'resolver-test',
    policy: { weight: 1, reservePercent: 0, allowUnknown: true, maxAgeMs: 1000 },
  };
  return { profile, pool, worktree: join(import.meta.dir, '../../../..'), prompt: 'Resolve only the supplied source paths.' };
}

test('the Codex resolver constructs a fresh sandbox command without ordinary worker permissions or schema', () => {
  // Flag-like source evidence must stay opaque, never participate in command rewriting.
  const input = { ...options(), prompt: '--dangerously-bypass-approvals-and-sandbox', research: true };
  const [program, args] = launchCommand({ ...input, resolver: true });
  const flags = args.slice(0, args.indexOf('--'));
  expect(program).toBe(input.pool.command);
  expect(flags[0]).toBe('exec');
  expect(flags).toContain('--json');
  expect(flags[flags.indexOf('-m') + 1]).toBe(input.profile.model);
  expect(flags).toContain('model_reasoning_effort=high');
  expect(flags[flags.indexOf('-s') + 1]).toBe('workspace-write');
  expect(flags).toContain('approval_policy="never"');
  expect(flags).toContain('--ignore-user-config');
  expect(flags).toContain('project_doc_max_bytes=0');
  expect(flags).toContain('web_search="disabled"');
  expect(flags).toContain('features.multi_agent=false');
  expect(flags).toContain('features.multi_agent_v2=false');
  expect(flags[flags.indexOf('-C') + 1]).toBe(input.worktree);
  expect(flags).not.toContain('resume');
  expect(flags).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(flags).not.toContain('--output-schema');
  expect(flags).not.toContain('web_search="live"');
  expect(args.slice(args.indexOf('--'))).toEqual(['--', input.prompt]);

  const ordinary = codexAdapter.start(options())[1];
  expect(ordinary).toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(ordinary).toContain('--output-schema');
});

test('both the neutral launcher and Codex adapter refuse resolver session reuse', () => {
  const input = { ...options(), resolver: true, resumeSession: 'prior-worker-session' };
  expect(() => launchCommand(input)).toThrow('fresh session');
  expect(() => codexAdapter.start(input)).toThrow('fresh session');
  expect(() => codexAdapter.resume({ ...input, session: input.resumeSession })).toThrow('fresh session');
});

test('resolver support follows the selected adapter capability rather than its CLI identity', () => {
  const input = options('cursor');
  const received: AgentLaunchOptions[] = [];
  const adapter: AgentAdapter = {
    ...agentAdapter('cursor'),
    supportsResolver: true,
    resume() { throw new Error('resume must not run'); },
    start(value) {
      received.push(value);
      return ['bounded-adapter', ['fresh-sandbox', value.worktree, value.prompt]];
    },
  };
  expect(launchCommand({ ...input, resolver: true }, () => adapter))
    .toEqual(['bounded-adapter', ['fresh-sandbox', input.worktree, input.prompt]]);
  expect(received).toHaveLength(1);
  expect(received[0]!.profile).toEqual(input.profile);
  expect(received[0]!.pool).toEqual(input.pool);
  expect(received[0]!.resolver).toBe(true);
  expect(received[0]!.resumeSession).toBeUndefined();
  expect(() => launchCommand({ ...input, resolver: true, resumeSession: 'old' }, () => adapter))
    .toThrow('fresh session');
  expect(received).toHaveLength(1);
});

test('adapters without the resolver capability refuse without falling back to worker start or resume', () => {
  for (const cli of ['claude', 'grok', 'cursor', 'codex'] as const) {
    const { supportsResolver: _capability, ...unsupported } = agentAdapter(cli);
    const adapter: AgentAdapter = {
      ...unsupported,
      start() { throw new Error('ordinary start must not run'); },
      resume() { throw new Error('resume must not run'); },
    };
    expect(() => launchCommand({ ...options(cli), resolver: true }, () => adapter))
      .toThrow('does not support train resolution');
    if (cli !== 'codex') expect(agentAdapter(cli).supportsResolver).toBeUndefined();
  }
});
