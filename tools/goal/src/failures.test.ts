import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateOutcome, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';
import { launchCommand, workerEnvironment } from './launch.ts';
import { fixturePool } from './test-support.ts';

const noCommit = `#!/usr/bin/env bun
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'BLOCKER: fixing the declared assertion'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
const cases: { name: string; expected: string; fact?: 'spec-conflict'; change?: Partial<GateOutcome>; prepare?: 'repeated' | 'round' | 'stall' | 'consulted' | 'early'; manager?: boolean }[] = [
  { name: 'setup failure', expected: 'environment', change: { stage: 'setup' } },
  { name: 'test also fails on main', expected: 'environment', change: { failsOnMain: true } },
  { name: 'timeout', expected: 'environment', change: { timedOut: true } },
  { name: 'new assertion', expected: 'new-failure' },
  { name: 'same first assertion', expected: 'repeated-assertion', prepare: 'repeated' },
  { name: 'specification conflict', expected: 'spec-conflict', fact: 'spec-conflict', manager: true },
  { name: 'scope stage', expected: 'scope-growth', change: { stage: 'scope' }, manager: true },
  { name: 'undeclared file', expected: 'scope-growth', change: { changedFiles: ['outside.ts'] }, manager: true },
  { name: 'estimate exceeded twice over', expected: 'scope-growth', change: { diffLines: 201 }, manager: true },
  { name: 'estimate exceeded within tolerance', expected: 'new-failure', change: { diffLines: 200 } },
  { name: 'no commit before class limit', expected: 'stalled', prepare: 'stall', manager: true },
  { name: 'two fix rounds', expected: 'round-limit', prepare: 'round', manager: true },
  { name: 'failure after consultation', expected: 'failed-after-consult', prepare: 'consulted', manager: true },
  { name: 'success claimed before failed gate', expected: 'early-stop', prepare: 'early' },
];
for (const item of cases) test(`recorded gate outcome: ${item.name}`, async () => {
  const h = harness(noCommit), inbox: ManagerEvent[] = [], consultations: string[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: e => inbox.push(e) }, async (_tasks, ref, directory) => {
      consultations.push(directory); h.store.assertCurrent(ref); return 'Use the minimal correction.';
    });
    await job.start(task.id);
    const ref = { taskId: task.id, attempt: 1 };
    if (item.fact) h.store.updateAttempt(ref, a => { a.failureKind = item.fact!; });
    if (item.prepare === 'repeated') h.store.updateAttempt(ref, a => { a.previousFailure = 'assertion'; a.fixRound = 1; });
    if (item.prepare === 'round') h.store.updateAttempt(ref, a => { a.fixRound = 2; });
    if (item.prepare === 'consulted') h.store.updateAttempt(ref, a => { a.consulted = true; });
    if (item.prepare === 'early') h.store.updateAttempt(ref, a => { a.blocker = null; a.result = 'RESULT: success'; });
    if (item.prepare === 'stall') { const record = h.store.record(ref)!; record.steps = 301; h.store.putRecord(record); }
    const outcome: GateOutcome = { ...ref, passed: false, stage: 'gate', firstFailure: { fingerprint: 'assertion', assertion: 'value equals expected', excerpt: 'actual differs' },
      logPath: 'fixture', hostMs: 25, changedFiles: ['result.txt'], diffLines: 1, ...item.change };
    job.onGateOutcome(outcome); await job.drain();
    const record = h.store.record(ref)!;
    expect(record.escalation).toBe(item.expected); expect(record.firstFailure).toBe(outcome.firstFailure!.fingerprint); expect(record.hostMs).toBe(25);
    const directory = h.store.attempt(ref).evidencePath;
    expect(readdirSync(directory).sort()).toEqual(['approaches.json', 'contract.md', 'diff.patch', 'failure.json']);
    expect(JSON.parse(readFileSync(join(directory, 'failure.json'), 'utf8')).assertion).toBe(outcome.firstFailure!.assertion);
    if (item.manager) { expect(inbox.map(e => e.kind)).toEqual([item.expected as ManagerEvent['kind']]); expect(h.store.task(task.id).currentAttempt).toBe(1); }
    else {
      expect(inbox).toEqual([]); expect(h.store.task(task.id).currentAttempt).toBe(2);
      const next = h.store.attempt({ taskId: task.id, attempt: 2 });
      expect(next.profile).toEqual(h.store.attempt(ref).profile);
      expect(next.pool).toBe('fixture'); expect(next.fixRound).toBe(item.expected === 'environment' ? 0 : item.prepare === 'repeated' ? 2 : 1);
    }
    expect(consultations.length).toBe(item.expected === 'repeated-assertion' ? 1 : 0);
    // Replayed gate notifications do not launch another attempt or wake another manager.
    if (item.manager) { job.onGateOutcome(outcome); expect(inbox.length).toBe(1); }
  } finally { h.dispose(); }
});
test('pool exhaustion retries on another locally allowed pool without changing model or consuming a fix round', async () => {
  const h = harness(noCommit);
  try {
    const pool = h.settings.pools[0]!; h.settings.pools.push({ ...pool, name: 'other', allowanceKey: 'other' });
    const task = h.tasks.dispatch(h.briefFile), job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    h.store.updateAttempt({ taskId: task.id, attempt: 1 }, a => { a.failureKind = 'pool-exhausted'; });
    job.onGateOutcome({ taskId: task.id, attempt: 1, passed: false, stage: 'gate', logPath: 'fixture', hostMs: 0, changedFiles: [], diffLines: 0,
      firstFailure: { fingerprint: 'provider-failure', assertion: 'quota unavailable', excerpt: 'retry elsewhere' } });
    await job.drain();
    const first = h.store.attempt({ taskId: task.id, attempt: 1 }), next = h.store.attempt({ taskId: task.id, attempt: 2 });
    expect(next.pool).not.toBe(first.pool); expect(next.profile).toEqual(first.profile); expect(next.fixRound).toBe(0);
  } finally { h.dispose(); }
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
    const task = h.tasks.dispatch(h.briefFile), job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    const ref = { taskId: task.id, attempt: 1 };
    h.store.updateAttempt(ref, a => { a.previousFailure = 'same'; a.fixRound = 1; });
    job.onGateOutcome({ ...ref, passed: false, stage: 'gate', logPath: 'fixture', hostMs: 1, changedFiles: [], diffLines: 0,
      firstFailure: { fingerprint: 'same', assertion: 'guard rejects input', excerpt: 'accepted unexpectedly' } });
    await job.drain();
    const args: string[] = JSON.parse(readFileSync(join(h.settings.stateDirectory, 'consult-args.json'), 'utf8'));
    expect(args).toContain('read-only'); expect(args).toContain('gpt-6.1-sol'); expect(args).toContain('model_reasoning_effort=medium');
    expect(args.at(-1)).toContain('guard rejects input'); expect(args.at(-1)).not.toContain('BLOCKER: fixing the assertion');
    const next = h.store.attempt({ taskId: task.id, attempt: 2 });
    expect(next.consulted).toBe(true); expect(next.profile.model).toBe('gpt-6-luna'); expect(next.session).toBe('worker-2');
    expect(h.store.events(task.id).filter(e => e.kind === 'consultation-completed')).toHaveLength(1);
    expect(readdirSync(h.store.attempt(ref).evidencePath).some(f => f.endsWith('.jsonl'))).toBe(false);
  } finally { h.dispose(); }
});
test('official CLI flags preserve dash-leading prompts, per-pool configuration, and isolated native sessions', () => {
  const pool = fixturePool();
  for (const cli of ['codex', 'grok', 'cursor'] as const) {
    const [command, args] = launchCommand({ profile: { cli, model: cli === 'codex' ? 'gpt-6-luna' : 'grok-4.7', effort: 'high', poolClass: cli },
      pool: { ...pool, cli, command: cli }, worktree: '/fixture', prompt: '---\ncontract', logPath: '/fixture/log' });
    expect(command).toBe(cli); expect(args.at(-1)).toBe(cli === 'grok' ? '--single=---\ncontract' : '---\ncontract');
    if (cli === 'codex') { expect(args).toContain('exec'); expect(args).toContain('--json'); expect(args).toContain('model_reasoning_effort=high'); }
    const env = workerEnvironment({ ...pool, cli }, {}, { CODEX_HOME: 'wrong', CODEX_THREAD_ID: 'manager', GROK_HOME: 'wrong', CURSOR_CONFIG_DIR: 'wrong' });
    expect(env.CODEX_THREAD_ID).toBeUndefined();
    expect(env[cli === 'codex' ? 'CODEX_HOME' : cli === 'grok' ? 'GROK_HOME' : 'CURSOR_CONFIG_DIR']).toBe(pool.configDirectory);
  }
});

test('Codex workers disable the account MCP servers with one merged inline table', () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-mcp-'));
  writeFileSync(join(directory, 'config.toml'), '[mcp_servers.browser]\nurl = "http://127.0.0.1:1/mcp"\n[mcp_servers."two.part"]\ncommand = "x"\n');
  const [, args] = launchCommand({ profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: fixturePool(directory), worktree: '/fixture', prompt: 'contract', logPath: '/fixture/log' });
  expect(args.filter(arg => arg.startsWith('mcp_servers'))).toEqual(['mcp_servers={"browser"={enabled=false},"two.part"={enabled=false}}']);
});
