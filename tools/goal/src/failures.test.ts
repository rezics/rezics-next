import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateOutcome, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';
import { launchCommand, workerEnvironment } from './launch.ts';
import { fixturePool } from './test-support.ts';
import { storybookServers } from './storybook.ts';

const noCommit = `#!/usr/bin/env bun
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'BLOCKER: fixing the declared assertion'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
const controlPlanePath = 'tools/goal/src/result.ts';
const outsideFiles = Array.from({ length: 9 }, (_, index) => `outside-${index}.ts`);
const cases: {
  name: string;
  expected: string;
  fact?: 'spec-conflict';
  change?: Partial<GateOutcome>;
  prepare?: 'repeated' | 'round' | 'stall' | 'consulted' | 'early';
  manager?: boolean;
  /** Control-plane work keeps the lifecycle limits that product work on dev no longer has. */
  controlPlane?: boolean;
  outsidePaths?: string[];
  estimateOverrun?: { lines: number; files: number; estimate: { lines: number; files: number } };
}[] = [
  { name: 'setup failure', expected: 'environment', change: { stage: 'setup' } },
  { name: 'test also fails on main', expected: 'environment', change: { failsOnMain: true } },
  { name: 'timeout', expected: 'environment', change: { timedOut: true } },
  { name: 'new assertion', expected: 'new-failure' },
  // Product work on dev stops when the same landing failure comes back; other work is consulted first.
  { name: 'same first assertion on dev', expected: 'stalled', prepare: 'repeated', manager: true },
  {
    name: 'same control-plane first assertion',
    expected: 'repeated-assertion',
    prepare: 'repeated',
    controlPlane: true,
  },
  { name: 'specification conflict', expected: 'spec-conflict', fact: 'spec-conflict', manager: true },
  { name: 'scope stage', expected: 'scope-growth', change: { stage: 'scope' }, manager: true },
  {
    name: 'undeclared file on dev is recorded and retried',
    expected: 'new-failure',
    change: { changedFiles: ['outside.ts'] },
    outsidePaths: ['outside.ts'],
  },
  {
    name: 'undeclared files on dev do not count toward the file estimate',
    expected: 'new-failure',
    change: { changedFiles: ['result.txt', ...outsideFiles] },
    outsidePaths: outsideFiles,
  },
  {
    name: 'undeclared control-plane file',
    expected: 'scope-growth',
    change: { changedFiles: ['outside.ts'] },
    manager: true,
    controlPlane: true,
    outsidePaths: ['outside.ts'],
  },
  {
    name: 'estimate exceeded twice over on dev is recorded and retried',
    expected: 'new-failure',
    change: { diffLines: 201 },
    estimateOverrun: { lines: 201, files: 1, estimate: { lines: 100, files: 4 } },
  },
  {
    name: 'control-plane estimate exceeded twice over',
    expected: 'scope-growth',
    change: { stage: 'merge', diffLines: 201 },
    manager: true,
    controlPlane: true,
  },
  { name: 'estimate exceeded within tolerance', expected: 'new-failure', change: { diffLines: 200 } },
  { name: 'no commit before class limit', expected: 'stalled', prepare: 'stall', manager: true },
  { name: 'two fix rounds on dev continue', expected: 'new-failure', prepare: 'round' },
  {
    name: 'two control-plane fix rounds',
    expected: 'round-limit',
    prepare: 'round',
    manager: true,
    controlPlane: true,
  },
  { name: 'failure after consultation on dev continues', expected: 'new-failure', prepare: 'consulted' },
  {
    name: 'control-plane failure after consultation',
    expected: 'failed-after-consult',
    prepare: 'consulted',
    manager: true,
    controlPlane: true,
  },
  { name: 'success claimed before failed gate', expected: 'early-stop', prepare: 'early' },
];
for (const item of cases)
  test(`recorded gate outcome: ${item.name}`, async () => {
    const h = harness(noCommit),
      inbox: ManagerEvent[] = [],
      consultations: string[] = [];
    try {
      if (item.controlPlane)
        writeFileSync(
          h.briefFile,
          markdown
            .replace('goal: fixture', 'goal: control-plane\ntarget: main')
            .replace('paths: [result.txt]', `paths: [${controlPlanePath}]`),
        );
      const task = h.tasks.dispatch(h.briefFile);
      const job = new WorkerJob(
        h.tasks,
        { enqueue() {} },
        { deliver: (e) => inbox.push(e) },
        async (_tasks, ref, directory) => {
          consultations.push(directory);
          h.store.assertCurrent(ref);
          return 'Use the minimal correction.';
        },
      );
      await job.start(task.id);
      const ref = { taskId: task.id, attempt: 1 };
      if (item.fact)
        h.store.updateAttempt(ref, (a) => {
          a.failureKind = item.fact!;
        });
      if (item.prepare === 'repeated')
        h.store.updateAttempt(ref, (a) => {
          a.previousFailure = 'assertion';
          a.fixRound = 1;
        });
      if (item.prepare === 'round')
        h.store.updateAttempt(ref, (a) => {
          a.fixRound = 2;
        });
      if (item.prepare === 'consulted')
        h.store.updateAttempt(ref, (a) => {
          a.consulted = true;
        });
      if (item.prepare === 'early')
        h.store.updateAttempt(ref, (a) => {
          a.blocker = null;
          a.result = 'RESULT: success';
        });
      if (item.prepare === 'stall') {
        const record = h.store.record(ref)!;
        record.steps = 301;
        h.store.putRecord(record);
      }
      const outcome: GateOutcome = {
        ...ref,
        passed: false,
        stage: 'gate',
        firstFailure: { fingerprint: 'assertion', assertion: 'value equals expected', excerpt: 'actual differs' },
        logPath: 'fixture',
        hostMs: 25,
        changedFiles: [item.controlPlane ? controlPlanePath : 'result.txt'],
        diffLines: 1,
        ...item.change,
      };
      job.onGateOutcome(outcome);
      await job.drain();
      const record = h.store.record(ref)!;
      expect(record.escalation).toBe(item.expected);
      expect(record.outsidePaths).toEqual(item.outsidePaths);
      expect(record.estimateOverrun).toEqual(item.estimateOverrun);
      expect(record.firstFailure).toBe(outcome.firstFailure!.fingerprint);
      expect(record.hostMs).toBe(25);
      const directory = h.store.attempt(ref).evidencePath;
      expect(readdirSync(directory).sort()).toEqual(['approaches.json', 'contract.md', 'diff.patch', 'failure.json']);
      expect(JSON.parse(readFileSync(join(directory, 'failure.json'), 'utf8')).assertion).toBe(
        outcome.firstFailure!.assertion,
      );
      if (item.manager) {
        expect(inbox.map((e) => e.kind)).toEqual([item.expected as ManagerEvent['kind']]);
        expect(h.store.task(task.id).currentAttempt).toBe(1);
      } else {
        expect(inbox).toEqual([]);
        expect(h.store.task(task.id).currentAttempt).toBe(2);
        const next = h.store.attempt({ taskId: task.id, attempt: 2 });
        expect(next.profile).toEqual(h.store.attempt(ref).profile);
        expect(next.pool).toBe('fixture');
        const previousRound = item.prepare === 'repeated' ? 1 : item.prepare === 'round' ? 2 : 0;
        expect(next.fixRound).toBe(previousRound + (item.expected === 'environment' ? 0 : 1));
      }
      expect(consultations.length).toBe(item.expected === 'repeated-assertion' ? 1 : 0);
      // Replayed gate notifications do not launch another attempt or wake another manager.
      if (item.manager) {
        job.onGateOutcome(outcome);
        expect(inbox.length).toBe(1);
      }
    } finally {
      h.dispose();
    }
  });
const sessionWorker = (commits: boolean) => `#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('.temp', { recursive: true });
appendFileSync('.temp/worker-argv.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
if (${commits}) {
  appendFileSync('result.txt', 'attempt ' + process.env.GOAL_ATTEMPT + '\\n');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-qm', 'Fix attempt ' + process.env.GOAL_ATTEMPT]);
}
console.log(JSON.stringify({type:'thread.started',thread_id:'dev-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'BLOCKER: fixing the declared assertion'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
function landingFailure(taskId: string, attempt: number, fingerprint: string): GateOutcome {
  return {
    taskId,
    attempt,
    passed: false,
    stage: 'gate',
    firstFailure: { fingerprint, assertion: `typecheck ${fingerprint}`, excerpt: 'actual differs' },
    logPath: 'fixture',
    hostMs: 1,
    changedFiles: ['result.txt'],
    diffLines: 1,
  };
}
test('product landing failures on dev resume the same session while it commits, until the same failure comes back', async () => {
  const h = harness(sessionWorker(true)),
    inbox: ManagerEvent[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(
      h.tasks,
      { enqueue() {} },
      { deliver: (event) => inbox.push(event) },
      async () => 'Use the minimal correction.',
    );
    await job.start(task.id);
    h.store.updateAttempt({ taskId: task.id, attempt: 1 }, (attempt) => {
      attempt.fixRound = 2;
      attempt.consulted = true;
    });
    // Past the round limit and a consultation, a new failure resumes the session; the same failure again stops it.
    for (const [attempt, fingerprint] of [
      [1, 'first'],
      [2, 'second'],
      [3, 'second'],
    ] as const) {
      job.onGateOutcome(landingFailure(task.id, attempt, fingerprint));
      await job.drain();
    }
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 3, branch: task.branch, state: 'stopped' });
    expect([1, 2, 3].map((attempt) => h.store.record({ taskId: task.id, attempt })?.escalation)).toEqual([
      'new-failure',
      'new-failure',
      'stalled',
    ]);
    expect(inbox.map((event) => [event.kind, event.summary])).toEqual([
      ['stalled', 'Repeated landing failure: typecheck second'],
    ]);
    const launches = readFileSync(join(task.worktree, '.temp/worker-argv.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(launches).toHaveLength(3);
    for (const argv of launches.slice(1))
      expect(argv.slice(argv.indexOf('resume'), argv.indexOf('resume') + 2)).toEqual(['resume', 'dev-session']);
  } finally {
    const current = h.store.tasks()[0];
    if (current?.state === 'running') await h.tasks.stop(current.id);
    h.dispose();
  }
}, 60_000);
test('two consecutive product attempts on dev without a new commit stop the task and notify its manager', async () => {
  const h = harness(sessionWorker(false)),
    inbox: ManagerEvent[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.start(task.id);
    job.onGateOutcome(landingFailure(task.id, 1, 'first'));
    await job.drain();
    expect(inbox).toEqual([]);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    job.onGateOutcome(landingFailure(task.id, 2, 'second'));
    await job.drain();
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 2, state: 'stopped' });
    expect(h.store.record({ taskId: task.id, attempt: 2 })?.escalation).toBe('stalled');
    expect(inbox.map((event) => [event.kind, event.summary])).toEqual([
      ['stalled', 'No new commit in two consecutive attempts: typecheck second'],
    ]);
    const progress = h.store.events(task.id).filter((event) => event.kind === 'attempt-progress');
    expect(progress.map((event) => JSON.parse(event.body).progress)).toEqual([false, false]);
  } finally {
    h.dispose();
  }
}, 60_000);
test('pool exhaustion retries on another locally allowed pool without changing model or consuming a fix round', async () => {
  const h = harness(noCommit);
  try {
    const pool = h.settings.pools[0]!;
    h.settings.pools.push({ ...pool, name: 'other', allowanceKey: 'other' });
    const task = h.tasks.dispatch(h.briefFile),
      job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    h.store.updateAttempt({ taskId: task.id, attempt: 1 }, (a) => {
      a.failureKind = 'pool-exhausted';
    });
    job.onGateOutcome({
      taskId: task.id,
      attempt: 1,
      passed: false,
      stage: 'gate',
      logPath: 'fixture',
      hostMs: 0,
      changedFiles: [],
      diffLines: 0,
      firstFailure: { fingerprint: 'provider-failure', assertion: 'quota unavailable', excerpt: 'retry elsewhere' },
    });
    await job.drain();
    const first = h.store.attempt({ taskId: task.id, attempt: 1 }),
      next = h.store.attempt({ taskId: task.id, attempt: 2 });
    expect(next.pool).not.toBe(first.pool);
    expect(next.profile).toEqual(first.profile);
    expect(next.fixRound).toBe(0);
  } finally {
    h.dispose();
  }
});
test('one real read-only Sol consultation consumes only the evidence bundle, then returns to a fresh worker session', async () => {
  const h = harness(`#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const consult=process.argv.includes('read-only');
if(consult) writeFileSync(join(dirname(process.env.CODEX_HOME),'consult-args.json'),JSON.stringify(process.argv));
console.log(JSON.stringify({type:'thread.started',thread_id:consult?'consultation':'worker-'+process.env.GOAL_ATTEMPT}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:consult?'Root cause: a missing guard. Add the guard.':'BLOCKER: fixing the assertion'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`);
  try {
    // Product work on dev stops on a repeated failure instead; control-plane work is still consulted.
    writeFileSync(
      h.briefFile,
      markdown
        .replace('goal: fixture', 'goal: control-plane\ntarget: main')
        .replace('paths: [result.txt]', `paths: [${controlPlanePath}]`),
    );
    const task = h.tasks.dispatch(h.briefFile),
      job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    const ref = { taskId: task.id, attempt: 1 };
    h.store.updateAttempt(ref, (a) => {
      a.previousFailure = 'same';
      a.fixRound = 1;
    });
    job.onGateOutcome({
      ...ref,
      passed: false,
      stage: 'gate',
      logPath: 'fixture',
      hostMs: 1,
      changedFiles: [],
      diffLines: 0,
      firstFailure: { fingerprint: 'same', assertion: 'guard rejects input', excerpt: 'accepted unexpectedly' },
    });
    await job.drain();
    const args: string[] = JSON.parse(readFileSync(join(h.settings.stateDirectory, 'consult-args.json'), 'utf8'));
    expect(args).toContain('read-only');
    expect(args).toContain('gpt-6.1-sol');
    expect(args).toContain('model_reasoning_effort=medium');
    expect(args.at(-1)).toContain('guard rejects input');
    expect(args.at(-1)).not.toContain('BLOCKER: fixing the assertion');
    const next = h.store.attempt({ taskId: task.id, attempt: 2 });
    expect(next.consulted).toBe(true);
    expect(next.profile.model).toBe('gpt-6-luna');
    expect(next.session).toBe('worker-2');
    expect(h.store.events(task.id).filter((e) => e.kind === 'consultation-completed')).toHaveLength(1);
    expect(readdirSync(h.store.attempt(ref).evidencePath).some((f) => f.endsWith('.jsonl'))).toBe(false);
  } finally {
    h.dispose();
  }
});
test('official CLI flags preserve dash-leading prompts, per-pool configuration, and isolated native sessions', () => {
  const pool = fixturePool();
  for (const cli of ['codex', 'grok', 'cursor'] as const) {
    const [command, args] = launchCommand({
      profile: { cli, model: cli === 'codex' ? 'gpt-6-luna' : 'grok-4.7', effort: 'high', poolClass: cli },
      pool: { ...pool, cli, command: cli },
      worktree: '/fixture',
      prompt: '---\ncontract',
      logPath: '/fixture/log',
    });
    expect(command).toBe(cli);
    expect(args.at(-1)).toBe(cli === 'grok' ? '--single=---\ncontract' : '---\ncontract');
    if (cli === 'codex') {
      expect(args).toContain('exec');
      expect(args).toContain('--json');
      expect(args).toContain('model_reasoning_effort=high');
    }
    const env = workerEnvironment(
      { ...pool, cli },
      {},
      { CODEX_HOME: 'wrong', CODEX_THREAD_ID: 'manager', GROK_HOME: 'wrong', CURSOR_CONFIG_DIR: 'wrong' },
    );
    expect(env.CODEX_THREAD_ID).toBeUndefined();
    expect(env[cli === 'codex' ? 'CODEX_HOME' : cli === 'grok' ? 'GROK_HOME' : 'CURSOR_CONFIG_DIR']).toBe(
      pool.configDirectory,
    );
  }
});

test('Codex workers keep the account MCP servers and add only the worktree Storybook servers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-mcp-'));
  const config = '[mcp_servers.browser]\nurl = "http://127.0.0.1:1/mcp"\n[mcp_servers."two.part"]\ncommand = "x"\n';
  writeFileSync(join(directory, 'config.toml'), config);
  const servers = (worktree: string) =>
    storybookServers(worktree, { kind: 'interface', paths: ['apps/web/src/a.tsx'] });
  const overrides = (worktree: string, extra: { resumeSession?: string; consultation?: boolean } = {}) => {
    const [, args] = launchCommand({
      profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
      pool: fixturePool(directory),
      worktree,
      prompt: 'contract',
      logPath: '/fixture/log',
      mcpServers: servers(worktree),
      ...extra,
    });
    return args.filter((arg) => arg.startsWith('mcp_servers'));
  };
  const one = servers('/trees/one');
  expect(one.map((server) => server.project)).toEqual(['packages/ui', 'apps/web']);
  expect(overrides('/trees/one')).toEqual(one.map((server) => `mcp_servers."${server.name}".url="${server.url}"`));
  expect(overrides('/trees/one', { resumeSession: 'session' })).toEqual(overrides('/trees/one'));
  expect(servers('/trees/two').map((server) => server.port)).not.toEqual(one.map((server) => server.port));
  expect(overrides('/trees/one', { consultation: true })).toEqual([]);
  expect(storybookServers('/trees/one', { kind: 'implementation', paths: ['tools/goal/src/a.ts'] })).toEqual([]);
  expect(readFileSync(join(directory, 'config.toml'), 'utf8')).toBe(config);
});
