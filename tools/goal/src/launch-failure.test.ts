import { expect, test } from 'bun:test';
import type { GateOutcome, LandingRequest, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';

// The CLI fails while loading its configuration: no session starts, nothing is written to stdout, nothing is committed.
const brokenCli = `#!/usr/bin/env bun
console.error('Error loading config.toml: invalid transport in mcp_servers."browser"');
process.exit(1);
`;

test('a launch failure is rerun once without a gate, then goes to the manager', async () => {
  const h = harness(brokenCli), inbox: ManagerEvent[] = [], landings: LandingRequest[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue: request => landings.push(request) }, { deliver: event => inbox.push(event) });
    await job.start(task.id); await job.drain();
    expect(landings).toEqual([]);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    for (const attempt of [1, 2]) expect(h.store.attempt({ taskId: task.id, attempt }).failureKind).toBe('tool');
    expect(h.store.record({ taskId: task.id, attempt: 2 })!.escalation).toBe('stalled');
    expect(inbox.map(event => event.kind)).toEqual(['stalled']);
    expect(inbox[0]!.summary).toContain('invalid transport');
  } finally { h.dispose(); }
});

const committingCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('result.txt', String(Date.now()));
spawnSync('git', ['add', 'result.txt']); spawnSync('git', ['commit', '-qm', 'result']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test('the same environment failure twice in a row goes to the manager instead of a third attempt', async () => {
  const h = harness(committingCli), inbox: ManagerEvent[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: event => inbox.push(event) });
    await job.start(task.id);
    const setup = (attempt: number): GateOutcome => ({ taskId: task.id, attempt, passed: false, stage: 'setup', logPath: 'fixture',
      hostMs: 1, changedFiles: ['result.txt'], diffLines: 1,
      firstFailure: { fingerprint: 'lockfile', assertion: 'lockfile had changes', excerpt: 'bun install --frozen-lockfile' } });
    job.onGateOutcome(setup(1)); await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(inbox).toEqual([]);
    job.onGateOutcome(setup(2)); await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.record({ taskId: task.id, attempt: 2 })!.escalation).toBe('stalled');
    expect(inbox.map(event => event.kind)).toEqual(['stalled']);
  } finally { h.dispose(); }
});
