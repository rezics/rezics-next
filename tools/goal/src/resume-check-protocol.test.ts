import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexAdapter } from './agents/codex.ts';
import { withAgentAdapter } from './agents.ts';
import { WorkerJob } from './job.ts';
import { workerPrompt } from './launch.ts';
import { settle } from './settle.ts';
import { harness } from './test-support.ts';
import { git } from './tasks.ts';

const checkId = '6a938d41-a3c8-4fc3-bf49-7d1b207fa85e';
const oldPrompt =
  'Saved session instructions from an older launch: use bun scripts/worker-check.ts --wait <id> until it exits.';
const waitingResult = JSON.stringify({
  status: 'waiting',
  summary: 'acceptance check is running',
  blocker: null,
  checks: [checkId],
  approaches: [],
});
const failedResult = JSON.stringify({
  status: 'blocked',
  summary: 'fixture failure',
  blocker: { kind: 'tool', detail: 'initial fixture failure' },
  checks: null,
  approaches: [],
});

function protocolCli(firstAnswer: string): string {
  return `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = join(process.cwd(), '.temp/goal');
const callsPath = join(directory, 'cli-calls.txt');
const calls = Number(existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '0') + 1;
writeFileSync(callsPath, String(calls));
const resumed = process.argv.includes('resume');
const savedPromptPath = join(directory, 'saved-session-prompt.txt');
const session = resumed || calls === 1 ? 'legacy-session' : 'fresh-session';
if (!resumed && calls === 1) {
  writeFileSync(savedPromptPath, ${JSON.stringify(oldPrompt)});
  writeFileSync(join(directory, 'initial-argv.json'), JSON.stringify(process.argv));
}
if (!resumed && calls === 1 && ${JSON.stringify(firstAnswer)} === ${JSON.stringify(waitingResult)})
  spawnSync(process.execPath, [join(process.cwd(), 'scripts/worker-check.ts'), '--', 'true'], { encoding: 'utf8' });
if (resumed || calls > 1) {
  writeFileSync(join(directory, 'continued-argv.json'), JSON.stringify({
    argv: process.argv,
    savedPrompt: readFileSync(savedPromptPath, 'utf8'),
    resumed,
    calls,
  }));
  writeFileSync('resumed.txt', 'continued');
  spawnSync('git', ['add', 'resumed.txt']);
  spawnSync('git', ['commit', '-qm', 'Continue fake worker session']);
}
console.log(JSON.stringify({type:'thread.started',thread_id:session}));
if (!resumed && calls === 1)
  console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:${JSON.stringify(firstAnswer)}}}));
else
  console.log(JSON.stringify({type:'item.completed',item:{id:'continued-answer',type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
}

function addCheckRunner(h: ReturnType<typeof harness>): void {
  mkdirSync(join(h.root, 'scripts'), { recursive: true });
  writeFileSync(
    join(h.root, 'scripts/worker-check.ts'),
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const path = '.temp/goal/check-start-count';
const count = Number(existsSync(path) ? readFileSync(path, 'utf8') : '0') + 1;
writeFileSync(path, String(count));
console.log('check: id ${checkId}');
`,
  );
  git(h.root, ['add', '--', 'scripts/worker-check.ts']);
  git(h.root, ['commit', '-m', 'Add worker-check fixture']);
}

async function waitForFile(path: string): Promise<void> {
  for (let n = 0; n < 500; n++) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function expectCurrentCheckProtocol(prompt: string): void {
  expect(prompt).toContain('bun scripts/worker-check.ts -- <command...>');
  expect(prompt).toContain('`{"status":"waiting","checks":["<bare UUID>"]}`');
  expect(prompt).toContain('Do not return another waiting result for those same check ids');
  expect(prompt).toContain('A terminal success result must use `"checks":[]`');
  expect(prompt).toContain('Do not run the root typecheck, affected checks or other regression checks yourself');
  expect(prompt).toContain(
    'The landing batch runs the root typecheck, affected checks for every changed path, and matching sibling tests',
  );
  const pollingInstructions = prompt
    .split(/(?<=[.!?])\s+/)
    .filter(
      (sentence) =>
        /\b(?:poll(?:ing)?|--wait)\b/i.test(sentence) &&
        !/\b(?:do not|don't|never|obsolete|superseded|previous session may contain)\b/i.test(sentence),
    );
  expect(pollingInstructions).toEqual([]);
}

async function startAttempt(h: ReturnType<typeof harness>) {
  const task = h.tasks.dispatch(h.briefFile);
  const worker = await h.tasks.retry(task.id);
  await worker.exited;
  const landings: unknown[] = [];
  await settle(h.tasks, worker, { enqueue: (request) => landings.push(request) });
  return { task: h.store.task(task.id), worker, landings };
}

test('a wake resumes the saved old session with current protocol and exact terminal check results', async () => {
  const h = harness(protocolCli(waitingResult));
  try {
    addCheckRunner(h);
    const { task, worker } = await startAttempt(h);
    const waiting = h.store.attempt(worker.attempt);
    expect(waiting.state).toBe('waiting');
    expect(waiting.checks).toEqual([checkId]);
    expect(waiting.session).toBe('legacy-session');
    expect(JSON.parse(readFileSync(join(task.worktree, '.temp/goal/initial-argv.json'), 'utf8')).at(-1)).toContain(
      'bare UUID string printed by the wrapper',
    );
    expect(readFileSync(join(task.worktree, '.temp/goal/saved-session-prompt.txt'), 'utf8')).toContain('--wait');

    const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(resultDirectory, { recursive: true });
    writeFileSync(
      join(resultDirectory, `${checkId}.json`),
      JSON.stringify({ exitStatus: 0, failureSummary: 'passed', logPath: `.temp/goal/checks/${checkId}.log` }),
    );

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const recovery = job.recoverOrphans();
    const continuedPath = join(task.worktree, '.temp/goal/continued-argv.json');
    await waitForFile(continuedPath);
    await recovery;

    const continued = JSON.parse(readFileSync(continuedPath, 'utf8')) as {
      argv: string[];
      savedPrompt: string;
      resumed: boolean;
      calls: number;
    };
    expect(continued.resumed).toBe(true);
    expect(continued.calls).toBe(2);
    expect(continued.savedPrompt).toContain('bun scripts/worker-check.ts --wait <id>');
    expect(continued.argv).toContain('resume');
    expect(continued.argv).toContain('legacy-session');
    expect(continued.argv).not.toContain('--wait');
    const prompt = continued.argv.at(-1)!;
    expectCurrentCheckProtocol(prompt);
    expect(prompt).toContain(
      'check ' + checkId + ': exit status 0; passed; log path .temp/goal/checks/' + checkId + '.log',
    );
    expect(prompt).toContain('Every checks entry must be the bare UUID string');
    expect(prompt).toContain('superseded instruction');
    expect(prompt).toContain('Do not invoke `bun scripts/worker-check.ts --wait <id>`');
    expect(prompt).toContain('Do not return another waiting result for those same check ids');
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.attempt(worker.attempt).session).toBe('legacy-session');
    expect(readFileSync(join(task.worktree, '.temp/goal/cli-calls.txt'), 'utf8')).toBe('2');
    expect(readFileSync(join(task.worktree, '.temp/goal/check-start-count'), 'utf8')).toBe('1');
    expect(readFileSync(join(task.worktree, 'resumed.txt'), 'utf8')).toBe('continued');
  } finally {
    h.dispose();
  }
});

test('a normal retry sends the current check protocol through the same-session resume argv', async () => {
  const h = harness(protocolCli(failedResult));
  try {
    addCheckRunner(h);
    const { task, worker } = await startAttempt(h);
    expect(h.store.attempt(worker.attempt).failureKind).toBe('tool');
    expect(h.store.attempt(worker.attempt).session).toBe('legacy-session');

    const retry = await h.tasks.retry(task.id);
    await waitForFile(join(task.worktree, '.temp/goal/continued-argv.json'));
    const continued = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/continued-argv.json'), 'utf8')) as {
      argv: string[];
      savedPrompt: string;
      resumed: boolean;
      calls: number;
    };
    expect(continued.resumed).toBe(true);
    expect(continued.calls).toBe(2);
    expect(continued.savedPrompt).toContain('--wait <id>');
    expect(continued.argv).toContain('resume');
    expect(continued.argv).toContain('legacy-session');
    expect(continued.argv).not.toContain('--wait');
    expectCurrentCheckProtocol(continued.argv.at(-1)!);
    expect(continued.argv.at(-1)).toContain('Every checks entry must be the bare UUID string');
    expect(continued.argv.at(-1)).toContain('Do not invoke `bun scripts/worker-check.ts --wait <id>`');
    expect(h.store.attempt(retry.attempt).attempt).toBe(2);
    await retry.exited;
    await settle(h.tasks, retry, { enqueue() {} });
    expect(h.store.attempt(retry.attempt).session).toBe('legacy-session');
    expect(readFileSync(join(task.worktree, '.temp/goal/cli-calls.txt'), 'utf8')).toBe('2');
  } finally {
    h.dispose();
  }
});

test('a nonresumable adapter starts a fresh turn with the check protocol and supplied results', async () => {
  const h = harness(protocolCli(waitingResult));
  try {
    addCheckRunner(h);
    const { task, worker } = await startAttempt(h);
    const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(resultDirectory, { recursive: true });
    writeFileSync(
      join(resultDirectory, `${checkId}.json`),
      JSON.stringify({
        exitStatus: 7,
        failureSummary: 'assertion failed',
        logPath: `.temp/goal/checks/${checkId}.log`,
      }),
    );
    const continuedPath = join(task.worktree, '.temp/goal/continued-argv.json');
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const recovery = withAgentAdapter({ ...codexAdapter, canResume: false }, () => job.recoverOrphans());
    await waitForFile(continuedPath);
    await recovery;
    const continued = JSON.parse(readFileSync(continuedPath, 'utf8')) as {
      argv: string[];
      savedPrompt: string;
      resumed: boolean;
      calls: number;
    };
    expect(continued.resumed).toBe(false);
    expect(continued.calls).toBe(2);
    expect(continued.argv).not.toContain('resume');
    expect(continued.argv).not.toContain('--wait');
    expect(continued.savedPrompt).toContain('--wait <id>');
    const prompt = continued.argv.at(-1)!;
    expectCurrentCheckProtocol(prompt);
    expect(prompt).toContain('bun scripts/worker-check.ts -- <command...>');
    expect(prompt).toContain(`check ${checkId}: exit status 7; assertion failed`);
    expect(prompt).toContain('bare UUID string printed by the wrapper');
    expect(prompt).toContain('superseded instruction');
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.attempt(worker.attempt).session).toBe('fresh-session');
    expect(readFileSync(join(task.worktree, '.temp/goal/check-start-count'), 'utf8')).toBe('1');
  } finally {
    h.dispose();
  }
});

test('a base without worker-check keeps the documented foreground fallback', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const prompt = workerPrompt(h.store.task(task.id), undefined, undefined, [], h.settings.mainCheckout);
    expect(prompt).toContain('This base has no scripts/worker-check.ts; do not add one.');
    expect(prompt).toContain('Run the acceptance command in the foreground from the worktree root and let it finish');
    expect(prompt).not.toContain('bun scripts/worker-check.ts -- <command...>');
    expect(prompt).not.toContain('"status":"waiting"');
  } finally {
    h.dispose();
  }
});

test('a contract-named existing runner outside the worktree enables detached checks', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const runner = join(h.root, 'scripts/worker-check.ts');
    mkdirSync(join(h.root, 'scripts'), { recursive: true });
    writeFileSync(runner, '');
    expect(existsSync(join(task.worktree, 'scripts/worker-check.ts'))).toBe(false);
    const contractText = `Run bun ${JSON.stringify(runner)} --local -- bun -e 'process.exit(0)' once.`;
    const prompt = workerPrompt(
      { ...task, brief: { ...task.brief, markdown: contractText } },
      undefined,
      undefined,
      [],
      h.settings.mainCheckout,
    );
    expect(prompt).toContain(`as \`bun ${JSON.stringify(runner)} -- <command...>\``);
    expect(prompt).toContain('Do not invoke `bun scripts/worker-check.ts --wait <id>`');
    expect(prompt).toContain('`{"status":"waiting","checks":["<bare UUID>"]}`');
    expect(prompt).not.toContain('This base has no scripts/worker-check.ts; do not add one.');
  } finally {
    h.dispose();
  }
});

test('different repeated tool blockers report the current committed attempt without claiming a failed CLI launch', async () => {
  const oldCause = 'EACCES: old disposable fixture cleanup';
  const currentCause = 'Cannot execute shell command: current session exposes no callable shell tool.';
  const h = harness(`#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const attempt = Number(process.env.GOAL_ATTEMPT);
writeFileSync('result.txt', 'committed source attempt ' + attempt);
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-qm', 'Complete source attempt ' + attempt]);
console.log(JSON.stringify({type:'thread.started',thread_id:'notice-session'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'source',type:'command_execution',command:'git commit and true',exit_code:0,status:'completed'}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify({
  status:'blocked', summary:'source and local check completed; current tool unavailable',
  blocker:{kind:'tool',detail:attempt === 1 ? ${JSON.stringify(oldCause)} : ${JSON.stringify(currentCause)}},
  checks:[], approaches:[],
})}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`);
  try {
    const { task, worker } = await startAttempt(h);
    expect(h.store.attempt(worker.attempt).blocker).toBe(oldCause);
    const current = await h.tasks.retry(task.id);
    await current.exited;
    await settle(h.tasks, current, { enqueue() {} });
    expect(git(task.worktree, ['log', '-1', '--format=%s'])).toBe('Complete source attempt 2');
    const notices: string[] = [];
    const job = new WorkerJob(
      h.tasks,
      { enqueue() {} },
      {
        deliver(event) {
          notices.push(event.summary);
        },
      },
    );
    job.onAttemptExit(current.attempt);
    expect(notices).toEqual([`Repeated tool failure: ${currentCause}`]);
    expect(notices[0]).not.toContain(oldCause);
    expect(notices[0]).not.toContain('launch failure');
    expect(h.store.attempt(current.attempt).blocker).toBe(currentCause);
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(h.store.retryIntent(current.attempt)).toBeUndefined();
    const context = h.store
      .events(task.id, current.attempt.attempt)
      .find((event) => event.kind === 'repeated-tool-failure');
    expect(JSON.parse(context!.body)).toEqual({
      current: { attempt: 2, detail: currentCause },
      previous: { attempt: 1, detail: oldCause },
    });
  } finally {
    h.dispose();
  }
});
