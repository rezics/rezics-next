import { describe, expect, test } from 'bun:test';
import { agentAdapter, type AgentAdapter } from './agents.ts';
import { launchCommand } from './launch.ts';
import type { Cli, Pool, Profile } from './types.ts';

const pool = (cli: Cli): Pool => ({ name: cli, cli, command: cli, configDirectory: '/tmp/config', classes: ['implementation'], allowanceKey: cli, policy: { weight: 1, reservePercent: 0, allowUnknown: true, maxAgeMs: 1000 } });
const profile = (cli: Cli): Profile => ({ cli, model: cli === 'codex' ? 'gpt-6-luna' : 'claude-sonnet', effort: 'high', poolClass: 'implementation' });

describe('agent adapters', () => {
  test('Codex and Claude own start, resume, session, exit and allowance behavior', () => {
    const codex = agentAdapter('codex');
    const claude = agentAdapter('claude');
    expect(launchCommand({ profile: profile('codex'), pool: pool('codex'), worktree: '/work', prompt: 'task' })[1]).toContain('exec');
    expect(launchCommand({ profile: profile('claude'), pool: pool('claude'), worktree: '/work', prompt: 'task', resumeSession: 's' })[1]).toContain('--resume');
    expect(codex.sessionId({ type: 'thread.started', thread_id: 'c' })).toBe('c');
    expect(claude.sessionId({ type: 'system', subtype: 'init', session_id: 'a' })).toBe('a');
    expect(claude.isRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })).toBe(true);
    expect(codex.isRateLimit({ type: 'turn.failed', error: { code: 'usage_limit_exceeded' } })).toBe(true);
    expect(codex.environment(pool('codex'), {}).CODEX_HOME).toBe('/tmp/config');
  });

  test('a fake adapter can start, wait for a check, resume and finish a task', async () => {
    const events: string[] = [];
    const fake: AgentAdapter = {
      cli: 'codex', canResume: true, streamsLog: true,
      start() { events.push('start'); return ['fake', []]; },
      resume({ session }) { events.push(`resume:${session}`); return ['fake', []]; },
      parseExit(output) { return JSON.parse(output); },
      sessionId() { return 'fake-session'; },
      isRateLimit() { return false; },
      environment(_pool, env) { return env; },
      matchesEvent() { return false; },
      afterExit() {},
      parseUsage() { return null; },
      failure() { return null; },
      completed() { return false; },
    };
    const options = { profile: profile('codex'), pool: pool('codex'), worktree: '/work', prompt: 'task' };
    const resolveAdapter = () => fake;
    const [program] = launchCommand(options, resolveAdapter);
    expect(program).toBe('fake');
    const waiting = fake.parseExit('{"status":"waiting","checks":["check-1"]}') as { status: string; checks: string[] };
    expect(waiting).toEqual({ status: 'waiting', checks: ['check-1'] });
    launchCommand({ ...options, prompt: 'check passed', resumeSession: fake.sessionId({})! }, resolveAdapter);
    expect(fake.parseExit('{"status":"success"}')).toEqual({ status: 'success' });
    expect(events).toEqual(['start', 'resume:fake-session']);
  });
});

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withAgentAdapter } from './agents.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';
import { measureLog } from './records.ts';
import { readPool } from './usage.ts';

const fakeCli = `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
mkdirSync('.temp', { recursive: true });
console.log(JSON.stringify({ kind: 'identity', value: 'opaque-session' }));
if (args.includes('--continue') || args.at(-1).includes('check-fake: exit status')) {
  writeFileSync('.temp/continued.json', JSON.stringify(args));
  writeFileSync('result.txt', 'completed by fake adapter');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-m', 'Complete fake adapter task']);
  console.log(JSON.stringify({ kind: 'answer', value: 'FAKE_EXIT:' + JSON.stringify({ status: 'success' }) }));
} else {
  console.log(JSON.stringify({ kind: 'answer', value: 'FAKE_EXIT:' + JSON.stringify({ status: 'waiting', checks: ['check-fake'] }) }));
}
console.log(JSON.stringify({ kind: 'usage', input: 11, output: 3 }));
`;

function fakeAdapter(canResume = true): AgentAdapter {
  return {
    cli: 'codex', canResume, streamsLog: true,
    start({ pool, prompt }) { return [pool.command, ['--fresh', prompt]]; },
    resume({ pool, prompt, session }) { return [pool.command, ['--continue', session, prompt]]; },
    parseExit(output) {
      try { return JSON.parse(output.replace(/^FAKE_EXIT:/, '')); } catch { return null; }
    },
    matchesEvent(event) { return typeof event.kind === 'string'; },
    sessionId(event) { return event.kind === 'identity' ? event.value : null; },
    parseEvent(event) {
      if (event.kind === 'answer') return { answer: event.value, final: true };
      if (event.kind === 'usage') return { usage: { tokens: { input: event.input, cached: 0, output: event.output }, delta: false } };
      return null;
    },
    isRateLimit(event) { return event.kind === 'allowance-empty'; },
    failure(event) { return event.kind === 'failure' ? event.value : null; },
    completed(event) { return event.kind === 'done'; },
    environment(_pool, env) { return env; },
    afterExit() {},
    parseUsage() { return null; },
  };
}

for (const canResume of [true, false]) {
  test(`a fake agent runs the real task lifecycle through check wake (canResume=${canResume})`, async () => {
    await withAgentAdapter(fakeAdapter(canResume), async () => {
      const h = harness(fakeCli);
      try {
        const task = h.tasks.dispatch(h.briefFile);
        const landings: unknown[] = [];
        const job = new WorkerJob(h.tasks, { enqueue(request) { landings.push(request); } }, { deliver() {} });
        await job.start(task.id);
        const ref = { taskId: task.id, attempt: 1 };
        expect(h.store.attempt(ref).state).toBe('waiting');
        expect(h.store.attempt(ref).session).toBe('opaque-session');
        expect(h.store.attempt(ref).checks).toEqual(['check-fake']);
        expect(h.store.runningAttemptsCount()).toBe(0);
        expect(landings).toHaveLength(0);
        const results = join(task.worktree, '.temp/goal/checks/results');
        mkdirSync(results, { recursive: true });
        writeFileSync(join(results, 'check-fake.json'), JSON.stringify({ exitStatus: 0, summary: 'passed', logPath: 'fake.log' }));
        await job.recoverOrphans();
        await job.drain();
        const args = JSON.parse(readFileSync(join(task.worktree, '.temp/continued.json'), 'utf8')) as string[];
        expect(args[0]).toBe(canResume ? '--continue' : '--fresh');
        if (canResume) expect(args[1]).toBe('opaque-session');
        else {
          expect(args.at(-1)).toContain(task.brief.markdown);
          expect(args.at(-1)).toContain('retry manifest');
        }
        expect(args.at(-1)).toContain('check-fake: exit status 0; passed; log path fake.log');
        expect(readFileSync(join(task.worktree, 'result.txt'), 'utf8')).toBe('completed by fake adapter');
        expect(h.store.task(task.id).state).toBe('landing');
        expect(h.store.attempt(ref).result).toBe('FAKE_EXIT:{"status":"success"}');
        expect(h.store.record(ref)?.tokens).toEqual({ input: 11, cached: 0, output: 3 });
        expect(landings).toHaveLength(1);
      } finally { h.dispose(); }
    });
  }, 30_000);
}

test('adapter-specific usage, session, failures and pool observations reach the control plane', () => {
  const adapter = fakeAdapter();
  const log = [
    { kind: 'identity', value: 'custom' },
    { kind: 'usage', input: 7, output: 2 },
    { kind: 'failure', value: 'custom exhaustion' },
    { kind: 'allowance-empty' },
  ].map((event) => JSON.stringify(event)).join('\n');
  expect(measureLog(log, { adapter })).toMatchObject({ session: 'custom', tokens: { input: 7, cached: 0, output: 2 }, failureKind: 'pool-exhausted' });
  withAgentAdapter({ ...adapter, readAllowance(p, now) {
    return { pool: p.name, allowanceKey: p.allowanceKey, at: new Date(now).toISOString(), observedAt: null, windows: [], exhausted: true, error: null };
  } }, () => expect(readPool(pool('codex')).exhausted).toBe(true));
});

test('worker control-plane modules contain no branches on a concrete agent CLI or provider event format', () => {
  const source = import.meta.dir;
  for (const file of new Bun.Glob('*.ts').scanSync({ cwd: source })) {
    if (file.endsWith('.test.ts') || file === 'agents.ts') continue;
    const text = readFileSync(join(source, file), 'utf8');
    expect(text, file).not.toMatch(/\.cli\s*(?:===|!==)\s*['"](?:codex|claude|grok|cursor)['"]/);
  }
  const records = readFileSync(join(source, 'records.ts'), 'utf8');
  expect(records).not.toMatch(/['"](?:thread\.started|turn\.completed|token_usage_record|session_meta|rate_limit_event|tool_use)['"]/);
});

test('fix-round retries use the adapter session only for the same pool and model', async () => {
  await withAgentAdapter(fakeAdapter(), async () => {
    const h = harness(fakeCli);
    try {
      const task = h.tasks.dispatch(h.briefFile);
      const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
      await job.start(task.id);
      const previous = { taskId: task.id, attempt: 1 };
      // A check failure is handed to a new attempt of the same task.
      h.store.updateTask(previous, (current) => { current.state = 'stopped'; });
      h.store.updateAttempt(previous, (attempt) => { attempt.state = 'stopped'; });
      await job.start(task.id, { fixRound: 1 });
      const args = JSON.parse(readFileSync(join(task.worktree, '.temp/continued.json'), 'utf8')) as string[];
      expect(args.slice(0, 2)).toEqual(['--continue', 'opaque-session']);
      expect(h.store.attempt({ taskId: task.id, attempt: 2 }).fixRound).toBe(1);
    } finally { h.dispose(); }
  });
}, 30_000);

const poolCli = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const codex = args[0] === 'exec';
const resumed = args.includes('resume') || args.includes('--resume');
mkdirSync('.temp', { recursive: true });
appendFileSync('.temp/adapter-commands.jsonl', JSON.stringify(args) + '\\n');
writeFileSync('.temp/adapter-environment.json', JSON.stringify({ codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR }));
const answer = JSON.stringify(resumed ? { status: 'success' } : { status: 'waiting', checks: ['check-pool'] });
if (resumed) {
  writeFileSync('result.txt', 'pool completed');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-m', 'Complete pool task']);
}
if (codex) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'pool-session' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 2 } }));
} else {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'pool-session' }));
  console.log(JSON.stringify({ type: 'result', result: answer, session_id: 'pool-session', usage: { input_tokens: 12, output_tokens: 2 } }));
}
`;

for (const cli of ['codex', 'claude'] as const) {
  test(`${cli} pools start, park, resume and settle through the production adapter`, async () => {
    const h = harness(poolCli);
    try {
      const account = h.settings.pools[0]!;
      account.cli = cli;
      const routing = JSON.parse(readFileSync(h.settings.routingFile, 'utf8'));
      routing.classes.implementation.first = { ...profile(cli), poolClass: account.classes[0] };
      h.settings.routingFile = join(h.settings.stateDirectory, 'adapter-routing.json');
      writeFileSync(h.settings.routingFile, JSON.stringify(routing));
      const task = h.tasks.dispatch(h.briefFile);
      const landings: unknown[] = [];
      const job = new WorkerJob(h.tasks, { enqueue(request) { landings.push(request); } }, { deliver() {} });
      await job.start(task.id);
      const ref = { taskId: task.id, attempt: 1 };
      expect(h.store.attempt(ref).state).toBe('waiting');
      expect(h.store.attempt(ref).session).toBe('pool-session');
      const results = join(task.worktree, '.temp/goal/checks/results');
      mkdirSync(results, { recursive: true });
      writeFileSync(join(results, 'check-pool.json'), JSON.stringify({ exitStatus: 0, summary: 'passed', logPath: 'pool.log' }));
      await job.recoverOrphans();
      await job.drain();
      expect(h.store.task(task.id).state).toBe('landing');
      expect(landings).toHaveLength(1);
      const commands = readFileSync(join(task.worktree, '.temp/adapter-commands.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
      expect(commands).toHaveLength(2);
      expect(commands[0]![0]).toBe(cli === 'codex' ? 'exec' : '-p');
      expect(commands[1]).toContain(cli === 'codex' ? 'resume' : '--resume');
      expect(commands[1]).toContain('pool-session');
      expect(commands[1]!.at(-1)).toContain('check-pool: exit status 0; passed; log path pool.log');
      const env = JSON.parse(readFileSync(join(task.worktree, '.temp/adapter-environment.json'), 'utf8'));
      expect(env[cli]).toBe(account.configDirectory);
      expect(env[cli === 'codex' ? 'claude' : 'codex']).toBeUndefined();
    } finally { h.dispose(); }
  }, 30_000);
}

test('worker monitoring and consultation do not parse provider event schemas or inject provider flags', () => {
  for (const file of ['job.ts', 'watchdog.ts', 'settle.ts', 'consult.ts', 'launch.ts']) {
    const text = readFileSync(join(import.meta.dir, file), 'utf8');
    expect(text, file).not.toMatch(/['"](?:command_execution|tool_use|thread\.started|rate_limit_event|--skip-git-repo-check|--strict-mcp-config)['"]/);
  }
});

test('exit objects wrapped in prose are parsed by the adapter itself', () => {
  const exit = { status: 'blocked', blocker: { kind: 'tool', detail: 'example' } };
  for (const cli of ['codex', 'claude', 'grok', 'cursor'] as const)
    expect(agentAdapter(cli).parseExit(`Earlier: {"status":"waiting"}\nReport: ${JSON.stringify(exit)}`)).toEqual(exit);
});

test('an explicitly selected adapter owns opaque exit parsing without global registration', () => {
  const adapter: AgentAdapter = { ...fakeAdapter(), parseExit(output) {
    if (output === 'opaque-wait') return { status: 'waiting', checks: ['opaque-check'] };
    if (output === 'opaque-blocked') return { status: 'blocked', blocker: { kind: 'scope-growth', detail: 'custom detail' } };
    return null;
  } };
  const log = (value: string) => JSON.stringify({ kind: 'answer', value });
  expect(measureLog(log('opaque-wait'), { adapter }).waitingChecks).toEqual(['opaque-check']);
  expect(measureLog(log('opaque-blocked'), { adapter })).toMatchObject({ failureKind: 'scope-growth', blocker: 'custom detail' });
});
