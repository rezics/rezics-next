import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentAdapter } from './agents.ts';
import type { LandingRequest, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { FINAL_REPORT_PROMPT, FINAL_REPORT_REQUESTED } from './settle.ts';
import { harness } from './test-support.ts';

// The first run commits its work and exits 0 with prose instead of the exit object; a resume answers as configured.
const forgetfulCli = (resumedAnswer: string) => `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('.temp/goal', { recursive: true });
appendFileSync('.temp/goal/runs.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
const message = (text) => console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
if (process.argv.includes('resume')) message(${JSON.stringify(resumedAnswer)});
else {
  writeFileSync('result.txt', 'accepted');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-m', 'Complete fixture']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'report-session'}));
  console.log(JSON.stringify({type:'item.started',item:{type:'agent_message',text:'{"status":"success"'}}));
  message('All done, the change is committed.');
}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
const success = JSON.stringify({ status: 'success', summary: 'done', blocker: null, checks: [], approaches: [] });

async function run(resumedAnswer: string) {
  const h = harness(forgetfulCli(resumedAnswer));
  const landings: LandingRequest[] = [],
    inbox: ManagerEvent[] = [];
  const task = h.tasks.dispatch(h.briefFile);
  const ref = { taskId: task.id, attempt: 1 };
  const job = new WorkerJob(
    h.tasks,
    { enqueue: (request) => landings.push(request) },
    { deliver: (event) => inbox.push(event) },
  );
  await job.start(task.id);
  await job.drain();
  expect(h.store.attempt(ref).state).toBe('waiting');
  expect(landings).toEqual([]);
  await job.recoverOrphans();
  await job.drain();
  const runs = readFileSync(join(task.worktree, '.temp/goal/runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  return { h, ref, landings, runs };
}

test('an exit 0 without the exit object is asked for it once in the same session and attempt, then lands', async () => {
  const { h, ref, landings, runs } = await run(success);
  try {
    expect(runs).toHaveLength(2);
    expect(runs[1]).toContain('report-session');
    expect(runs[1]!.at(-1)).toBe(FINAL_REPORT_PROMPT);
    expect(h.store.task(ref.taskId).currentAttempt).toBe(1);
    expect(landings.map((request) => request.attempt)).toEqual([1]);
  } finally {
    h.dispose();
  }
});

test('a report-only continuation that still gives no report ends as the ordinary missing-report failure', async () => {
  const { h, ref, landings, runs } = await run('Still done.');
  try {
    // Attempt 1 asked once; what follows is the ordinary retry of a tool failure, not another report request.
    expect(runs[1]!.at(-1)).toBe(FINAL_REPORT_PROMPT);
    expect(runs.slice(2).map((argv) => argv.at(-1))).not.toContain(FINAL_REPORT_PROMPT);
    expect(landings).toEqual([]);
    expect(h.store.attempt(ref).failureKind).toBe('tool');
    expect(h.store.attempt(ref).result).toContain('without a success report (exit 0)');
    expect(h.store.events(ref.taskId, 1).filter((event) => event.kind === FINAL_REPORT_REQUESTED)).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test('Codex answers come only from completed agent messages', () => {
  const parse = (event: Record<string, unknown>) => agentAdapter('codex').parseEvent?.(event, false)?.answer;
  expect(parse({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } })).toBe('final');
  expect(parse({ type: 'item.started', item: { type: 'agent_message', text: 'partial' } })).toBeUndefined();
  expect(parse({ type: 'event_msg', payload: { type: 'agent_message', message: 'echo' } })).toBeUndefined();
});
