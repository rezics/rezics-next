import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consult, CONSULTATION_LIMIT_MS } from './consult.ts';
import { sameProcess } from './process.ts';
import { harness } from './test-support.ts';

type TimeoutParameters = Parameters<typeof setTimeout>;

const advice = 'Root cause: a missing guard. Add the guard. Acceptance is consistent.';

function consultCli(body: string): string {
  return `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('read-only')) {
${body}
} else {
  writeFileSync('result.txt', 'accepted');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-qm', 'Complete fixture']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'worker'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
}
`;
}

async function prepared(body: string) {
  const h = harness(consultCli(body));
  const task = h.tasks.dispatch(h.briefFile);
  const worker = await h.tasks.retry(task.id);
  await worker.exited;
  const ref = { taskId: task.id, attempt: h.store.task(task.id).currentAttempt };
  const directory = join(h.settings.stateDirectory, 'consult-evidence');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'contract.md'), 'contract');
  writeFileSync(join(directory, 'diff.patch'), '');
  writeFileSync(join(directory, 'failure.json'), '{}');
  writeFileSync(join(directory, 'approaches.json'), '[]');
  return { h, ref, directory };
}

function released(h: ReturnType<typeof harness>, ref: { taskId: string; attempt: number }) {
  for (const process of h.store.attempt(ref).auxiliaryProcesses) expect(sameProcess(process)).toBe(false);
}

async function refusedSecond(h: ReturnType<typeof harness>, ref: { taskId: string; attempt: number }, directory: string) {
  released(h, ref);
  await expect(consult(h.tasks, ref, directory)).rejects.toThrow('this task already used its one consultation');
}

test('A consultation yields usable advice or an actionable truthful terminal failure and releases its owned resources without a second invocation.', async () => {
  const success = await prepared(`
console.log(JSON.stringify({type:'thread.started',thread_id:'consultation'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(advice)}}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`);
  try {
    expect(await consult(success.h.tasks, success.ref, success.directory)).toBe(advice);
    expect(await Bun.file(join(success.directory, 'consultation.md')).text()).toBe(advice);
    expect(
      success.h.store.events(success.ref.taskId, success.ref.attempt).some((e) => e.kind === 'consultation-completed'),
    ).toBe(true);
    await refusedSecond(success.h, success.ref, success.directory);
  } finally {
    success.h.dispose();
  }

  const failure = await prepared(`
console.error('provider refused the session');
process.exit(2);
`);
  try {
    await expect(consult(failure.h.tasks, failure.ref, failure.directory)).rejects.toThrow(
      /consultation failed \(exit 2\): provider refused the session/,
    );
    expect(existsSync(join(failure.directory, 'consultation.md'))).toBe(false);
    expect(
      failure.h.store.events(failure.ref.taskId, failure.ref.attempt).some((e) => e.kind === 'consultation-completed'),
    ).toBe(false);
    expect(failure.h.store.attempt(failure.ref).consulted).toBe(true);
    await refusedSecond(failure.h, failure.ref, failure.directory);
  } finally {
    failure.h.dispose();
  }

  const empty = await prepared(`
console.log(JSON.stringify({type:'thread.started',thread_id:'consultation'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`);
  try {
    await expect(consult(empty.h.tasks, empty.ref, empty.directory)).rejects.toThrow(
      'consultation produced no usable advice',
    );
    expect(existsSync(join(empty.directory, 'consultation.md'))).toBe(false);
    await refusedSecond(empty.h, empty.ref, empty.directory);
  } finally {
    empty.h.dispose();
  }

  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: TimeoutParameters) => {
    if (args[1] === CONSULTATION_LIMIT_MS) {
      const immediate = [...args] as unknown[];
      immediate[1] = 100;
      return original(...(immediate as unknown as TimeoutParameters));
    }
    return original(...args);
  }) as typeof setTimeout;
  let hanging: Awaited<ReturnType<typeof prepared>> | undefined;
  try {
    hanging = await prepared(`
console.error('still waiting on provider');
setInterval(() => {}, 1000);
`);
    await expect(consult(hanging.h.tasks, hanging.ref, hanging.directory)).rejects.toThrow(
      /consultation timed out: still waiting on provider/,
    );
    expect(existsSync(join(hanging.directory, 'consultation.md'))).toBe(false);
    await refusedSecond(hanging.h, hanging.ref, hanging.directory);
  } finally {
    globalThis.setTimeout = original;
    hanging?.h.dispose();
  }
}, 60_000);
