import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { acquireDirectoryLease } from './lease.ts';
import { StaleAttemptError } from './contracts.ts';
import { captureLaunchContext, renderLaunchContext } from './launch-context.ts';
import { WorkerJob } from './job.ts';
import { SqliteLandingQueue } from './land.ts';
import { importAttempt } from './import-attempt.ts';
import { git, WorkerTasks } from './tasks.ts';
import { launchCommand, workerActivityBaseline } from './launch.ts';
import { authenticatedManager } from './priority-authority.ts';
import { runWorkerCommand } from './worker-commands.ts';
import type { Attempt } from './types.ts';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { harness, markdown, reading } from './test-support.ts';

const provider = `#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv;
const prompt = args.at(-1) ?? '';
const attempt = process.env.GOAL_ATTEMPT ?? 'unknown';
const resumed = args.includes('resume');
mkdirSync('.temp/goal', { recursive: true });
writeFileSync(join('.temp/goal', 'launch-' + attempt + '-' + (resumed ? 'resume' : 'start') + '.json'), JSON.stringify({ args, prompt }));
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session-' + process.env.GOAL_TASK_ID}));
if (!resumed && !prompt.includes('"boundary":"wake"') && prompt.includes('BEGIN_WAITING_SESSION')) {
  const id = randomUUID();
  const runPath = join('.temp/goal/checks/runs', id + '.json');
  const resultPath = join('.temp/goal/checks/results', id + '.json');
  const logPath = join('.temp/goal/checks', id + '.log');
  mkdirSync('.temp/goal/checks/runs', { recursive: true });
  mkdirSync('.temp/goal/checks/results', { recursive: true });
  const releasePath = join('.temp/goal/checks', id + '.release');
  const failedPhysicalCheck = prompt.includes('RUN_FAILED_PHYSICAL_CHECK');
  const checkCommand = failedPhysicalCheck ? 'false' : 'true';
  const checkSummary = failedPhysicalCheck ? 'physical remote acceptance failed' : 'passed';
  const checkLog = 'remote performance receipt: the old runner exited nonzero before the canonical contract amendment';
  const childCode = "const {existsSync}=require('node:fs');const {spawnSync}=require('node:child_process');const {writeFileSync}=require('node:fs');const timer=setInterval(()=>{if(!existsSync(" + JSON.stringify(releasePath) + "))return;clearInterval(timer);const result=spawnSync(" + JSON.stringify(checkCommand) + ");if(result.status!==0)writeFileSync(" + JSON.stringify(logPath) + "," + JSON.stringify(checkLog) + ");writeFileSync(" + JSON.stringify(resultPath) + ",JSON.stringify({status:'finished',exitStatus:result.status,summary:" + JSON.stringify(checkSummary) + ",logPath:" + JSON.stringify(logPath) + "}));},10);";
  const check = spawn(process.execPath, ['-e', childCode], { detached: true, stdio: 'ignore' });
  writeFileSync(runPath, JSON.stringify({ status: 'running', runnerPid: check.pid, runnerHost: hostname(), logPath }));
  check.unref();
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'waiting',summary:'acceptance check running',checks:[id]})}}));
} else {
  writeFileSync('result.txt', 'accepted by attempt ' + attempt + '\\n');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-m', 'Complete launch-context fixture']);
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

function captured(task: { worktree: string }, attempt: number, kind: 'start' | 'resume') {
  return JSON.parse(readFileSync(join(task.worktree, `.temp/goal/launch-${attempt}-${kind}.json`), 'utf8')) as {
    args: string[];
    prompt: string;
  };
}

function contextFromPrompt(prompt: string): Record<string, any> {
  const title = prompt.indexOf('## Current controller launch context');
  const start = prompt.indexOf('```json\n', title);
  const end = prompt.indexOf('\n```', start + 8);
  if (title < 0 || start < 0 || end < 0)
    throw new Error('current launch-context JSON is missing from the provider argv');
  return JSON.parse(prompt.slice(start + 8, end)) as Record<string, any>;
}

function hash(markdownText: string): string {
  return createHash('sha256').update(markdownText.replace(/\r\n?/g, '\n').trimEnd()).digest('hex');
}

/** Local persisted-session fixture; it exercises authentication without invoking any provider. */
function prelaunchOwner(h: ReturnType<typeof harness>, id = 'fixture', sessionId: string = randomUUID()) {
  h.store.db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  h.store.db.query('INSERT OR REPLACE INTO manager_sessions VALUES (?, ?)').run(
    id,
    JSON.stringify({
      id,
      kind: 'managed',
      provider: 'codex',
      status: 'running',
      threadId: sessionId,
    }),
  );
  const env = { GOAL_MANAGER: id, CODEX_THREAD_ID: sessionId };
  const actor = authenticatedManager(h.store.db, env);
  if (!actor) throw new Error('persisted owner fixture failed authentication');
  return { env, actor };
}

function prelaunchTask(h: ReturnType<typeof harness>, text = markdown) {
  mkdirSync(join(h.settings.stateDirectory, 'briefs'), { recursive: true });
  const briefPath = fullBrief(h.root, `ordinary-${randomUUID()}`, text);
  return h.store.createTask(
    parseBrief(text, readRiskOwnership(h.settings.riskAreasFile)),
    {
      briefPath,
      worktree: h.root,
      branch: 'main',
      base: git(h.root, ['rev-parse', 'HEAD']),
    },
    'implementation',
  );
}

test('prelaunch amendment authenticates owner and operations, archives current input and preserves one intent and ordinary history', async () => {
  const h = harness();
  try {
    const task = prelaunchTask(h);
    const ref = { taskId: task.id, attempt: 0 };
    const owner = prelaunchOwner(h);
    h.settings.integration.operationsManager = 'operations';
    const operations = prelaunchOwner(h, 'operations');
    h.store.saveRetryIntent(ref, {});
    const intent = h.store.retryIntent(ref);
    expect(intent?.status).toBe('pending');
    h.store.updateTask(ref, (current) => {
      current.priorityHistory = [
        { value: 'normal', setter: null, grantor: null, at: task.createdAt, provenance: { kind: 'programmatic' } },
      ];
      current.priorityGrants = [];
    });
    const original = h.store.task(task.id);
    const updated = markdown.replace(
      'Write the requested result and commit it.',
      'Use the current accepted interface contract.',
    );
    const file = fullBrief(h.root, 'owner-amendment', updated);
    const printed: string[] = [];
    expect(
      await runWorkerCommand('amend', [task.id, '--expected-attempt', '0', '--brief', file], {
        tasks: h.tasks,
        env: owner.env,
        print: (value) => printed.push(value),
      }),
    ).toBe(0);
    expect(JSON.parse(printed[0]!)).toMatchObject({
      taskId: task.id,
      attempt: 0,
      status: 'amended',
      contractSha256: hash(updated),
    });
    let current = h.store.task(task.id);
    expect(current.brief.markdown).toBe(updated);
    expect(readFileSync(current.briefPath, 'utf8')).toBe(updated);
    expect(readFileSync(original.briefPath, 'utf8')).toBe(markdown);
    expect(current.priorityHistory).toEqual(original.priorityHistory);
    expect(current.priorityGrants).toEqual(original.priorityGrants);
    expect(h.store.retryIntent(ref)).toEqual(intent);
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(
      h.store
        .events(task.id, 0)
        .filter((event) => event.kind === 'prelaunch-contract-amended')
        .map((event) => JSON.parse(event.body)),
    ).toEqual([
      {
        actor: owner.actor,
        previous: { path: original.briefPath, sha256: hash(markdown), markdown },
        current: { path: current.briefPath, sha256: hash(updated), markdown: updated },
      },
    ]);
    const beforeReplay = JSON.stringify(current);
    expect(h.tasks.amend(task.id, { expectedAttempt: 0, brief: file }, owner.actor).status).toBe('unchanged');
    expect(JSON.stringify(h.store.task(task.id))).toBe(beforeReplay);
    const operationsText = updated.replace('current accepted interface', 'latest owner-supplied interface');
    const operationsFile = fullBrief(h.root, 'operations-amendment', operationsText);
    expect(h.tasks.amend(task.id, { expectedAttempt: 0, brief: operationsFile }, operations.actor).status).toBe(
      'amended',
    );
    current = h.store.task(task.id);
    expect(current.brief.manager).toBe(original.brief.manager);
    expect(current.sequence).toBe(original.sequence);
    expect(current.priorityHistory).toEqual(original.priorityHistory);
    expect(current.priorityGrants).toEqual(original.priorityGrants);
    expect(current.brief.criticalPath).toBe(false);
    expect(h.store.retryIntent(ref)).toEqual(intent);
    expect(h.store.attempts(task.id)).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('prelaunch amendment refuses missing, wrong, ambiguous and stale authority and rolls back failed archival atomically', () => {
  const h = harness();
  try {
    const task = prelaunchTask(h);
    const owner = prelaunchOwner(h);
    const stranger = prelaunchOwner(h, 'stranger');
    const file = fullBrief(h.root, 'refused-amendment', markdown + '\nCurrent input.\n');
    const options = { expectedAttempt: 0, brief: file };
    const original = JSON.stringify(h.store.task(task.id));
    const files = readdirSync(join(h.settings.stateDirectory, 'briefs'));
    for (const actor of [null, stranger.actor, { ...owner.actor, sessionId: 'obsolete-session' }])
      expect(() => h.tasks.amend(task.id, options, actor)).toThrow('authenticated');
    h.store.db.query('INSERT INTO manager_sessions VALUES (?, ?)').run(
      'ambiguous-owner',
      JSON.stringify({
        status: 'running',
        threadId: owner.actor.sessionId,
      }),
    );
    expect(() => h.tasks.amend(task.id, options, owner.actor)).toThrow('unambiguous');
    h.store.db.query('DELETE FROM manager_sessions WHERE id=?').run('ambiguous-owner');
    expect(() => h.tasks.amend(task.id, { ...options, expectedAttempt: 1 }, owner.actor)).toThrow('"attempt":0');
    const critical = fullBrief(
      h.root,
      'critical-amendment',
      (markdown + '\nChanged.\n').replace('criticalPath: false', 'criticalPath: true'),
    );
    expect(() => h.tasks.amend(task.id, { ...options, brief: critical }, owner.actor)).toThrow('ordinary priority');
    const outside = fullBrief(
      h.root,
      'unsafe-amendment',
      markdown.replace('paths: [result.txt]', 'paths: [../escape]'),
    );
    expect(() => h.tasks.amend(task.id, { ...options, brief: outside }, owner.actor)).toThrow();
    h.store.db.exec(`CREATE TRIGGER refuse_amendment BEFORE INSERT ON worker_events
      WHEN NEW.kind='prelaunch-contract-amended' BEGIN SELECT RAISE(ABORT, 'fixture archival failure'); END`);
    expect(() => h.tasks.amend(task.id, options, owner.actor)).toThrow('fixture archival failure');
    expect(JSON.stringify(h.store.task(task.id))).toBe(original);
    expect(readdirSync(join(h.settings.stateDirectory, 'briefs'))).toEqual(files);
    expect(h.store.events(task.id, 0).some((event) => event.kind === 'prelaunch-contract-amended')).toBe(false);
    expect(h.store.attempts(task.id)).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('prelaunch amendment supports genuinely held zero, preserves frozen input and refuses completed generations', () => {
  const h = harness();
  try {
    const owner = prelaunchOwner(h);
    const dependency = prelaunchTask(h);
    const frozenText = markdown + '\n```ts path=result.txt\nunchanged acceptance\n```\n';
    const task = prelaunchTask(h, frozenText.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`));
    expect(task.state).toBe('held');
    const removed = fullBrief(h.root, 'remove-prelaunch-dependency', frozenText + '\nLatest body.\n');
    expect(h.tasks.amend(task.id, { expectedAttempt: 0, brief: removed }, owner.actor).status).toBe('amended');
    expect(h.store.task(task.id).state).toBe('ready');
    const accepted = h.store.task(task.id);
    const mutated = fullBrief(
      h.root,
      'mutated-frozen',
      (frozenText + '\nNew body.\n').replace('unchanged acceptance', 'changed assertion'),
    );
    expect(() => h.tasks.amend(task.id, { expectedAttempt: 0, brief: mutated }, owner.actor)).toThrow(
      'frozen acceptance',
    );
    expect(h.store.task(task.id)).toEqual(accepted);
    h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
      current.state = 'integrated';
    });
    expect(() => h.tasks.amend(task.id, { expectedAttempt: 0, brief: removed }, owner.actor)).toThrow(
      '"state":"integrated"',
    );
    expect(h.store.attempts(task.id)).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('prelaunch amendment deliberately replaces stopped zero input without restarting historical or unknown custody', async () => {
  const h = harness();
  try {
    const owner = prelaunchOwner(h);
    h.settings.integration.operationsManager = 'operations';
    const operations = prelaunchOwner(h, 'operations');
    const stranger = prelaunchOwner(h, 'other');
    const dependency = prelaunchTask(h);
    const integrated = prelaunchTask(h);
    h.store.updateTask({ taskId: integrated.id, attempt: 0 }, (current) => {
      current.state = 'integrated';
      current.integratedCommit = integrated.base;
    });
    const text =
      markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}, ${integrated.id}]`) +
      '\n```ts path=result.txt\nunchanged acceptance\n```\n';
    const task = prelaunchTask(h, text);
    await h.tasks.stop(task.id);
    const ref = { taskId: task.id, attempt: 0 };
    const stopCause = { reason: 'Owner stopped the original input before admission.' };
    h.store.event(ref, 'stopped', stopCause);
    h.store.saveRetryIntent(ref, {});
    h.store.updateTask(ref, (current) => {
      current.priorityHistory = [
        { value: 'normal', setter: null, grantor: null, at: task.createdAt, provenance: { kind: 'programmatic' } },
      ];
      current.priorityGrants = [];
    });
    const intent = h.store.retryIntent(ref);
    const original = h.store.task(task.id);
    const source = git(h.root, ['rev-parse', 'HEAD']);
    expect(h.tasks.amend(task.id, { expectedAttempt: 0, brief: task.briefPath }, owner.actor).status).toBe('unchanged');
    expect(h.store.task(task.id)).toEqual(original);
    const replacement = fullBrief(h.root, 'stopped-replacement', text + '\nUse the complete current contract.\n');
    const options = { expectedAttempt: 0, brief: replacement };
    expect(() => h.tasks.amend(task.id, options, null)).toThrow('authenticated');
    expect(() => h.tasks.amend(task.id, options, stranger.actor)).toThrow('authenticated');
    expect(() => h.tasks.amend(task.id, { ...options, expectedAttempt: 1 }, owner.actor)).toThrow('"attempt":0');
    const changedFrozen = fullBrief(
      h.root,
      'stopped-frozen-change',
      text.replace('unchanged acceptance', 'changed assertion'),
    );
    expect(() => h.tasks.amend(task.id, { ...options, brief: changedFrozen }, owner.actor)).toThrow(
      'frozen acceptance',
    );
    expect(h.store.task(task.id)).toEqual(original);
    const printed: string[] = [];
    expect(
      await runWorkerCommand('amend', [task.id, '--expected-attempt', '0', '--brief', replacement], {
        tasks: h.tasks,
        env: owner.env,
        print: (value) => printed.push(value),
      }),
    ).toBe(0);
    expect(JSON.parse(printed[0]!)).toMatchObject({ taskId: task.id, attempt: 0, status: 'amended' });
    const accepted = h.store.task(task.id);
    expect(accepted.state).toBe('held');
    expect(accepted.brief.after).toEqual([dependency.id, integrated.id]);
    expect(h.tasks.dependenciesMet(accepted)).toBe(false);
    expect({ ...accepted, state: original.state, brief: original.brief, briefPath: original.briefPath }).toEqual(
      original,
    );
    expect(git(h.root, ['rev-parse', 'HEAD'])).toBe(source);
    expect(readFileSync(original.briefPath, 'utf8')).toBe(text);
    expect(h.store.events(task.id, 0).find((event) => event.kind === 'stopped')?.body).toBe(JSON.stringify(stopCause));
    expect(JSON.parse(h.store.events(task.id, 0).at(-1)!.body).previousState).toBe('stopped');
    expect(h.store.retryIntent(ref)).toEqual(intent);
    expect(h.store.attempts(task.id)).toEqual([]);
    // Configured operations delivers with its own genuine identity, including this deliberate stopped transition.
    await h.tasks.stop(task.id);
    const latest = fullBrief(h.root, 'stopped-operations-replacement', text + '\nUse the latest complete contract.\n');
    expect(h.tasks.amend(task.id, { expectedAttempt: 0, brief: latest }, operations.actor).status).toBe('amended');
    expect(h.store.task(task.id).state).toBe('held');
    expect(h.store.task(task.id).brief.after).toEqual([dependency.id, integrated.id]);
    expect(h.store.retryIntent(ref)).toEqual(intent);

    // A corrupt/legacy zero counter cannot erase any real prior invocation, settlement, proof or physical evidence.
    const evidence: Array<(id: string) => void> = [
      (id) => {
        h.store.db.query('INSERT INTO worker_attempts VALUES (?,?,?)').run(
          id,
          1,
          JSON.stringify({
            taskId: id,
            attempt: 1,
            state: 'stopped',
            process: null,
            logPath: 'original-worker.jsonl',
          }),
        );
      },
      (id) => {
        h.store.db.query('INSERT INTO worker_records VALUES (?,?,?)').run(id, 1, '{}');
      },
      (id) => {
        h.store.db
          .query('INSERT INTO worker_proof_reservations VALUES (?,?,?,?,?,?)')
          .run(randomUUID(), 'fixture', id, 2, 'released', '{}');
      },
      (id) => {
        h.store.db.query('INSERT INTO worker_integration_plans VALUES (?,?,?)').run(id, 1, '{}');
      },
      (id) => {
        new SqliteLandingQueue(h.store.db, h.store);
        h.store.db
          .query('INSERT INTO landing_queue(task,attempt,request,outcome,delivered) VALUES (?,?,?, ?,1)')
          .run(id, 1, '{}', '{"passed":true}');
      },
      (id) => {
        h.store.event({ taskId: id, attempt: 0 }, 'historical-proof-reader-unavailable', { custody: 'unknown' });
      },
      (id) => {
        const directory = join(h.settings.stateDirectory, 'runs', id);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'original.jsonl'), 'retained original worker output');
      },
      (id) => {
        const directory = join(h.settings.stateDirectory, 'check-registry', 'proof-reservations');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${randomUUID()}.json`), JSON.stringify({ binding: { taskId: id, attempt: 1 } }));
      },
      (id) => {
        const directory = join(h.root, '.temp/goal/checks/results');
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, `${randomUUID()}.json`),
          JSON.stringify({
            status: 'finished',
            exitCode: 0,
            ownership: { taskId: id, attempt: 1 },
          }),
        );
      },
      () => {
        const directory = join(h.root, '.temp/goal/checks/custody/history');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${randomUUID()}.json`), '{unreadable custody');
      },
    ];
    for (const recordEvidence of evidence) {
      const stopped = prelaunchTask(h);
      await h.tasks.stop(stopped.id);
      recordEvidence(stopped.id);
      const before = JSON.stringify(h.store.task(stopped.id));
      const history = h.store.events(stopped.id);
      const files = readdirSync(join(h.settings.stateDirectory, 'briefs'));
      expect(() => h.tasks.amend(stopped.id, options, owner.actor)).toThrow('prelaunch amendment');
      expect(JSON.stringify(h.store.task(stopped.id))).toBe(before);
      expect(h.store.events(stopped.id)).toEqual(history);
      expect(readdirSync(join(h.settings.stateDirectory, 'briefs'))).toEqual(files);
    }
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(h.store.task(task.id).state).toBe('held');
  } finally {
    h.dispose();
  }
});

test.each([false, true])(
  'prelaunch amendment during first capacity wait delivers exactly the latest canonical contract once through native argv (held release: %s)',
  async (heldRelease) => {
    const h = harness();
    const capacity = join(h.settings.stateDirectory, 'capacity.json');
    let pending: ReturnType<WorkerTasks['retry']> | undefined;
    try {
      git(h.root, ['branch', 'dev']);
      writeFileSync(join(h.settings.stateDirectory, 'verification-mode'), 'minimal');
      const dependency = heldRelease ? prelaunchTask(h) : undefined;
      const task = prelaunchTask(
        h,
        dependency ? markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`) : markdown,
      );
      if (dependency) {
        h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (current) => {
          current.state = 'integrated';
          current.integratedCommit = dependency.base;
        });
        underLease(h, task.id, () =>
          h.store.releaseHeldRetryTask({ taskId: task.id, attempt: 0 }, (current) => {
            current.state = 'ready';
          }),
        );
      }
      const owner = prelaunchOwner(h);
      const prompts: string[] = [];
      const tasks = new WorkerTasks(
        h.settings,
        h.store,
        reading,
        async (store, current, attempt, pool, prompt, codex) => {
          const [, argv] = launchCommand({
            profile: attempt.profile,
            pool,
            worktree: current.worktree,
            prompt,
            ...(codex ? { codex } : {}),
          });
          prompts.push(argv.at(-1)!);
          store.updateAttempt(attempt, (value) => {
            value.state = 'running';
          });
          store.updateTask(attempt, (value) => {
            value.state = 'running';
          });
          return { attempt: store.attempt(attempt), exited: Promise.resolve({ code: 0, signal: null }) };
        },
      );
      writeFileSync(capacity, JSON.stringify({ maxWorkers: 0, minAvailableMiB: 0 }));
      h.store.saveRetryIntent({ taskId: task.id, attempt: 0 }, {});
      const intent = h.store.retryIntent({ taskId: task.id, attempt: 0 });
      expect(intent?.status).toBe('pending');
      pending = heldRelease ? tasks.retryHeld(task.id) : tasks.retry(task.id, { expectedAttempt: 0 });
      const queue = join(h.settings.stateDirectory, 'capacity-queue');
      const tickets = readdirSync(queue);
      expect(tickets).toHaveLength(1);
      const ticket = readFileSync(join(queue, tickets[0]!), 'utf8');
      const revisedText = markdown.replace(
        'Write the requested result and commit it.',
        'The latest accepted interface includes the restored subject control.',
      );
      const revised = fullBrief(h.root, 'capacity-owner-amendment', revisedText);
      tasks.amend(task.id, { expectedAttempt: 0, brief: revised }, owner.actor);
      expect(readdirSync(queue)).toEqual(tickets);
      expect(readFileSync(join(queue, tickets[0]!), 'utf8')).toBe(ticket);
      expect(h.store.retryIntent({ taskId: task.id, attempt: 0 })).toEqual(intent);
      expect(h.store.attempts(task.id)).toEqual([]);
      writeFileSync(capacity, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
      await pending;
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(revisedText);
      expect(prompts[0]).not.toContain('Write the requested result and commit it.');
      expect(prompts[0]).toContain('return success (blocker null, `"checks":[]`)');
      expect(contextFromPrompt(prompts[0]!).task).toMatchObject({
        attempt: 1,
        contractSha256: hash(revisedText),
        contractProof: 'verified',
      });
      const current = h.store.task(task.id);
      const currentAttempt = h.store.attempt({ taskId: task.id, attempt: 1 });
      expect(() => tasks.amend(task.id, { expectedAttempt: 0, brief: revised }, owner.actor)).toThrow('"attempt":1');
      expect(() => tasks.amend(task.id, { expectedAttempt: 1, brief: revised }, owner.actor)).toThrow(
        '"attemptState":"running"',
      );
      expect(h.store.task(task.id)).toEqual(current);
      expect(h.store.attempt({ taskId: task.id, attempt: 1 })).toEqual(currentAttempt);
      expect(h.store.attempts(task.id)).toHaveLength(1);
      expect(prompts).toHaveLength(1);
    } finally {
      writeFileSync(capacity, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
      if (pending) await pending.catch(() => {});
      h.dispose();
    }
  },
);

test('current prompt accounting preserves adopted elapsed waits without borrowing earlier-turn log output or waits', () => {
  const h = harness();
  try {
    const task = prelaunchTask(h);
    const ref = { taskId: task.id, attempt: 0 };
    const logPath = join(h.settings.stateDirectory, 'accounting.jsonl');
    const waitPath = logPath.replace(/\.jsonl$/, '.check-wait');
    const now = Date.now();
    const promptStart = now - 350;
    writeFileSync(logPath, 'earlier turn output\n');
    utimesSync(logPath, new Date(now - 60_000), new Date(now - 60_000));
    const offset = statSync(logPath).size;
    writeFileSync(waitPath, '60000\n350\n');
    h.store.event(ref, 'worker-run-started', { logStartOffset: offset, checkWaitBaseline: 60000 });
    h.store.db
      .query("UPDATE worker_events SET at=? WHERE task_id=? AND kind='worker-run-started'")
      .run(new Date(promptStart).toISOString(), task.id);
    const attempt = { ...ref, logPath, startedAt: new Date(now - 120_000).toISOString() } as Attempt;
    const baseline = workerActivityBaseline(h.store, attempt, now);
    expect(baseline.startedAt).toBe(promptStart);
    expect(baseline.logStartOffset).toBe(offset);
    expect(baseline.lastLogActivityAt).toBe(promptStart);
    expect(baseline.checkWaitBaseline).toBe(60000);
    expect(baseline.checkWaitAtLastLogActivity).toBe(60000);
    appendFileSync(waitPath, '200\n');
    // Restart retains elapsed time and both waits; it does not start a new silence window.
    const adopted = workerActivityBaseline(h.store, attempt, now + 250);
    expect(adopted.startedAt).toBe(promptStart);
    expect(adopted.lastLogActivityAt).toBe(promptStart);
    expect(adopted.checkWaitAtLastLogActivity).toBe(60000);
    expect(now + 250 - adopted.lastLogActivityAt - (60550 - adopted.checkWaitAtLastLogActivity)).toBe(50);
    // A large historical wait may cover only the actual silent interval at adoption.
    writeFileSync(waitPath, '60000\n60000\n');
    expect(120000 - workerActivityBaseline(h.store, attempt, now).checkWaitAtLastLogActivity).toBe(350);
    writeFileSync(waitPath, '60000\n');
    expect(workerActivityBaseline(h.store, attempt, now).checkWaitAtLastLogActivity).toBe(60000);
  } finally {
    h.dispose();
  }
});

function initialBrief(root: string, name: string, body: string): string {
  const path = join(root, `.temp/goal/${name}.md`);
  writeFileSync(path, markdown.replace('Write the requested result and commit it.', body));
  return path;
}

function fullBrief(root: string, name: string, text: string): string {
  const path = join(root, `.temp/goal/${name}.md`);
  writeFileSync(path, text);
  return path;
}

function amendedBrief(root: string, name: string, after: string, body: string): string {
  const path = join(root, `.temp/goal/${name}.md`);
  const text = markdown
    .replace('waiting: []', `waiting: []\nafter: [${after}]`)
    .replace('Write the requested result and commit it.', body);
  writeFileSync(path, text);
  return path;
}

function contractRevision(body: string, command: string): string {
  return markdown
    .replace('command: [bun, test]', `command: ["sh", "-c", ${JSON.stringify(command)}]`)
    .replace('Write the requested result and commit it.', body);
}

function integratedDependency(h: ReturnType<typeof harness>, filename: string): { id: string; commit: string } {
  const dependency = h.tasks.dispatch(h.briefFile);
  writeFileSync(join(dependency.worktree, filename), `export const ${filename.replace(/\W/g, '_')} = true;\n`);
  git(dependency.worktree, ['add', filename]);
  git(dependency.worktree, ['commit', '-m', `Integrate ${filename}`]);
  const commit = git(dependency.worktree, ['rev-parse', 'HEAD']);
  const oldDev = git(h.root, ['rev-parse', 'refs/heads/dev']);
  git(h.root, ['update-ref', 'refs/heads/dev', commit, oldDev]);
  h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (current) => {
    current.state = 'integrated';
    current.integratedCommit = commit;
  });
  return { id: dependency.id, commit };
}

function replaceTaskContract(h: ReturnType<typeof harness>, taskId: string, attempt: number, text: string): void {
  const path = join(h.settings.stateDirectory, 'briefs', `launch-context-${randomUUID()}.md`);
  writeFileSync(path, text);
  const brief = parseBrief(text, readRiskOwnership(h.settings.riskAreasFile));
  h.store.updateTask({ taskId, attempt }, (task) => {
    task.brief = brief;
    task.briefPath = path;
  });
}

async function waitFor(path: string): Promise<void> {
  for (let n = 0; n < 200; n++) {
    try {
      readFileSync(path);
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForCapacityWaiter(stateDirectory: string, taskId: string): Promise<void> {
  const queue = join(stateDirectory, 'capacity-queue');
  for (let n = 0; n < 200; n++) {
    try {
      if (readdirSync(queue).some((name) => name.endsWith(`-${taskId}`))) return;
    } catch {
      // The first capacity waiter creates the queue.
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for task ${taskId} to queue for host capacity`);
}

function releaseOwnedCheck(task: { worktree: string }, id: string): void {
  const directory = join(task.worktree, '.temp/goal/checks');
  const run = JSON.parse(readFileSync(join(directory, 'runs', `${id}.json`), 'utf8')) as {
    status: string;
    runnerPid: number;
    runnerHost: string;
  };
  expect(run).toMatchObject({ status: 'running', runnerHost: hostname() });
  expect(Number.isSafeInteger(run.runnerPid)).toBe(true);
  process.kill(run.runnerPid, 0);
  expect(() => readFileSync(join(directory, 'results', `${id}.json`))).toThrow();
  writeFileSync(join(directory, `${id}.release`), 'release');
}

function releaseOutstandingChecks(task: { worktree: string }): void {
  const runs = join(task.worktree, '.temp/goal/checks/runs');
  try {
    for (const file of readdirSync(runs).filter((name) => name.endsWith('.json')))
      writeFileSync(join(task.worktree, '.temp/goal/checks', `${file.slice(0, -5)}.release`), 'release');
  } catch {
    // This task did not start a fixture check.
  }
}

function underLease<T>(h: ReturnType<typeof harness>, taskId: string, run: () => T): T {
  const lease = acquireDirectoryLease(join(h.settings.stateDirectory, 'leases', taskId));
  try {
    return run();
  } finally {
    lease.release();
  }
}

function fixtureAttempt(taskId: string, attempt: number, stateDirectory: string): Attempt {
  return {
    taskId,
    attempt,
    state: 'pending',
    profile: { cli: 'codex', model: 'fixture', effort: 'medium', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(stateDirectory, 'runs', taskId, `${attempt}.jsonl`),
    evidencePath: join(stateDirectory, 'evidence', taskId, String(attempt)),
    auxiliaryProcesses: [],
    session: null,
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: null,
    result: '',
    blocker: null,
    approaches: [],
  };
}

test('fresh and normal retry argv carry current contract identity and supersede historical retry prose', async () => {
  const h = harness(provider);
  try {
    const dependency = integratedDependency(h, 'retry-dependency.ts');
    const briefPath = amendedBrief(h.root, 'fresh-retry', dependency.id, 'Write the requested result and commit it.');
    const task = h.tasks.dispatch(briefPath);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);

    const first = captured(h.store.task(task.id), 1, 'start');
    const fresh = contextFromPrompt(first.prompt);
    expect(fresh).toMatchObject({ boundary: 'fresh', origin: 'managed' });
    expect(fresh.task).toMatchObject({
      id: task.id,
      attempt: 1,
      contractSha256: hash(task.brief.markdown),
      contractProof: 'verified',
      base: git(task.worktree, ['rev-parse', 'HEAD^']),
      sourceHead: git(task.worktree, ['rev-parse', 'HEAD^']),
      sourceBranch: task.branch,
      sourceProof: 'verified',
    });
    expect(first.prompt).toContain(`- \`${dependency.id}\`: integrated in your base at \`${dependency.commit}\`.`);

    const evidence = join(h.settings.stateDirectory, 'evidence', 'historical-retry');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      join(evidence, 'failure.json'),
      JSON.stringify({
        manifest:
          'Historical future-tense retry manifest: cleanup must merge before work; return waiting with checks [].',
      }),
    );
    const amendmentOne = amendedBrief(h.root, 'retry-one', dependency.id, 'Use contract amendment one.');
    await job.start(task.id, { brief: amendmentOne, evidence });
    const second = captured(h.store.task(task.id), 2, 'resume');
    const retry = contextFromPrompt(second.prompt);
    expect(retry).toMatchObject({ boundary: 'retry', origin: 'managed' });
    expect(retry.task).toMatchObject({
      id: task.id,
      attempt: 2,
      contractSha256: hash(readFileSync(amendmentOne, 'utf8')),
      contractProof: 'verified',
    });
    expect(second.prompt).toContain(`- \`${dependency.id}\`: integrated in your base at \`${dependency.commit}\`.`);
    expect(second.prompt.indexOf('Historical future-tense retry manifest')).toBeLessThan(
      second.prompt.indexOf('## Current controller launch context'),
    );

    const staleResult = 'OLD ATTEMPT RESULT: cleanup must merge before work';
    h.store.updateAttempt({ taskId: task.id, attempt: 2 }, (attempt) => {
      attempt.result = staleResult;
    });
    const amendmentTwo = amendedBrief(h.root, 'retry-two', dependency.id, 'Use the latest contract amendment.');
    await job.start(task.id, { brief: amendmentTwo, evidence });
    const third = captured(h.store.task(task.id), 3, 'resume');
    const latest = contextFromPrompt(third.prompt);
    expect(latest.task).toMatchObject({
      id: task.id,
      attempt: 3,
      contractPath: h.store.task(task.id).briefPath,
      contractSha256: hash(readFileSync(amendmentTwo, 'utf8')),
      contractProof: 'verified',
      sourceHead: git(task.worktree, ['rev-parse', 'HEAD^']),
      sourceProof: 'verified',
    });
    expect(third.prompt).toContain(`- \`${dependency.id}\`: integrated in your base at \`${dependency.commit}\`.`);
    expect(JSON.stringify(latest)).not.toContain(staleResult);
    expect(third.prompt.indexOf('Historical future-tense retry manifest')).toBeLessThan(
      third.prompt.indexOf('This prompt and these facts supersede saved sessions'),
    );
  } finally {
    h.dispose();
  }
});

test('held release resumes old sessions once with actual dependency source receipts for every released task', async () => {
  const h = harness(provider);
  const waitingTasks: { worktree: string }[] = [];
  try {
    const dependency = h.tasks.dispatch(h.briefFile);
    const firstPath = initialBrief(
      h.root,
      'held-first',
      'BEGIN_WAITING_SESSION\nHistorical future-tense instruction: wait for cleanup to merge before starting.',
    );
    const secondPath = initialBrief(
      h.root,
      'held-second',
      'BEGIN_WAITING_SESSION\nHistorical future-tense instruction: wait for cleanup to merge before starting.',
    );
    const first = h.tasks.dispatch(firstPath);
    const second = h.tasks.dispatch(secondPath);
    waitingTasks.push(first, second);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await Promise.all([job.start(first.id), job.start(second.id)]);

    for (const task of [first, second]) {
      const waiting = h.store.attempt({ taskId: task.id, attempt: 1 });
      expect(waiting.state).toBe('waiting');
      expect(waiting.checks).toHaveLength(1);
      expect(waiting.checks?.[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      releaseOwnedCheck(task, waiting.checks![0]!);
      await waitFor(join(task.worktree, '.temp/goal/checks/results', `${waiting.checks![0]}.json`));
    }

    const firstRevision = amendedBrief(h.root, 'held-first-v1', dependency.id, 'Use the first contract amendment.');
    const latestRevision = amendedBrief(
      h.root,
      'held-first-v2',
      dependency.id,
      'Use the latest contract after cleanup.',
    );
    const secondRevision = amendedBrief(h.root, 'held-second-v1', dependency.id, 'Use the released task contract.');
    h.tasks.queueRetry(first.id, { brief: firstRevision });
    h.tasks.queueRetry(first.id, { brief: latestRevision });
    h.tasks.queueRetry(second.id, { brief: secondRevision });
    expect(h.store.task(first.id).state).toBe('held');
    expect(h.store.task(second.id).state).toBe('held');

    writeFileSync(join(dependency.worktree, 'cleanup.ts'), 'export const cleanupReady = true;\n');
    git(dependency.worktree, ['add', 'cleanup.ts']);
    git(dependency.worktree, ['commit', '-m', 'Complete cleanup dependency']);
    const dependencyCommit = git(dependency.worktree, ['rev-parse', 'HEAD']);
    const oldDev = git(h.root, ['rev-parse', 'refs/heads/dev']);
    git(h.root, ['update-ref', 'refs/heads/dev', dependencyCommit, oldDev]);
    h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (current) => {
      current.state = 'integrated';
      current.integratedCommit = dependencyCommit;
    });

    await job.recoverOrphans();
    await job.drain();

    for (const task of [first, second]) {
      expect(h.store.task(task.id).currentAttempt).toBe(2);
      const resumed = captured(h.store.task(task.id), 2, 'resume');
      const context = contextFromPrompt(resumed.prompt);
      expect(resumed.args).toContain('resume');
      expect(context).toMatchObject({ boundary: 'held-release', origin: 'managed' });
      expect(context.task).toMatchObject({
        id: task.id,
        attempt: 2,
        base: dependencyCommit,
        sourceHead: dependencyCommit,
        sourceBranch: task.branch,
        sourceProof: 'verified',
        contractProof: 'verified',
      });
      expect(resumed.prompt).toContain(`- \`${dependency.id}\`: integrated in your base at \`${dependencyCommit}\`.`);
      expect(resumed.prompt).toContain(
        'This prompt and these facts supersede saved sessions, retry manifests and earlier results.',
      );
      expect(resumed.prompt).not.toContain('Historical future-tense instruction: wait for cleanup to merge');
      expect(h.store.attempts(task.id).filter((attempt) => attempt.attempt === 2)).toHaveLength(1);
    }
    expect(contextFromPrompt(captured(h.store.task(first.id), 2, 'resume').prompt).task.contractSha256).toBe(
      hash(readFileSync(latestRevision, 'utf8')),
    );
    expect(contextFromPrompt(captured(h.store.task(second.id), 2, 'resume').prompt).task.contractSha256).toBe(
      hash(readFileSync(secondRevision, 'utf8')),
    );
  } finally {
    for (const task of waitingTasks) releaseOutstandingChecks(task);
    h.dispose();
  }
});

test('a same-session check wake carries the current receipt in the actual provider argv', async () => {
  const h = harness(provider);
  let task: { id: string; worktree: string } | undefined;
  try {
    const dependency = integratedDependency(h, 'wake-dependency.ts');
    const briefPath = amendedBrief(
      h.root,
      'wake-context',
      dependency.id,
      'BEGIN_WAITING_SESSION\nComplete the task after the actual acceptance check finishes.',
    );
    task = h.tasks.dispatch(briefPath);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);

    const ref = { taskId: task.id, attempt: 1 };
    const waiting = h.store.attempt(ref);
    expect(waiting.state).toBe('waiting');
    expect(waiting.checks).toHaveLength(1);
    const id = waiting.checks![0]!;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    releaseOwnedCheck(task, id);
    await waitFor(join(task.worktree, '.temp/goal/checks/results', `${id}.json`));

    await job.recoverOrphans();

    const resumed = captured(h.store.task(task.id), 1, 'resume');
    const context = contextFromPrompt(resumed.prompt);
    expect(resumed.args).toContain('resume');
    expect(waiting.session).toBeTruthy();
    expect(resumed.args).toContain(waiting.session!);
    expect(context).toMatchObject({ boundary: 'wake', origin: 'managed' });
    expect(context.task).toMatchObject({
      id: task.id,
      attempt: 1,
      contractSha256: hash(h.store.task(task.id).brief.markdown),
      contractProof: 'verified',
      base: dependency.commit,
      sourceProof: 'verified',
    });
    expect(resumed.prompt).toContain(`- \`${dependency.id}\`: integrated in your base at \`${dependency.commit}\`.`);
    expect(resumed.prompt).toContain(`check ${id}: exit status 0; passed;`);
  } finally {
    if (task) releaseOutstandingChecks(task);
    h.dispose();
  }
});

test('a same-session wake replaces stale remote policy with the complete amended canonical contract', async () => {
  const h = harness(provider);
  let task: { id: string; worktree: string } | undefined;
  try {
    const remoteCommand = 'bun /remote/performance/scripts/worker-check.ts --suite admission';
    const initialText = contractRevision(
      [
        'BEGIN_WAITING_SESSION',
        'RUN_FAILED_PHYSICAL_CHECK',
        `The legacy policy requires running the remote campaign: \`${remoteCommand}\`.`,
        'The native marker timestamp unit is epoch milliseconds.',
      ].join('\n'),
      remoteCommand,
    );
    const initialPath = fullBrief(h.root, 'wake-canonical-old', initialText);
    const activeTask = h.tasks.dispatch(initialPath);
    task = activeTask;
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(activeTask.id);

    const ref = { taskId: activeTask.id, attempt: 1 };
    const waiting = h.store.attempt(ref);
    expect(waiting.state).toBe('waiting');
    expect(waiting.checks).toHaveLength(1);
    const id = waiting.checks![0]!;
    const originalSession = waiting.session;
    expect(originalSession).toBeTruthy();
    const initial = captured(h.store.task(activeTask.id), 1, 'start');
    expect(initial.prompt).toContain(remoteCommand);
    expect(initial.prompt).toContain('The native marker timestamp unit is epoch milliseconds.');
    const originalBriefPath = h.store.task(activeTask.id).briefPath;

    const currentCommand =
      'bun scripts/performance/admission-local.ts && bun scripts/performance/native-marker-local.ts';
    const currentText = contractRevision(
      [
        'BEGIN_WAITING_SESSION',
        'NORMAL direct local scripts-only acceptance. Run only the local scripts in acceptance.command from the task worktree.',
        'Do not invoke the remote worker-check campaign for this contract.',
        'Native marker timestamp unit correction: marker timestamps are epoch microseconds; compare epoch seconds by dividing by 1000000.',
      ].join('\n'),
      currentCommand,
    );
    underLease(h, activeTask.id, () => replaceTaskContract(h, activeTask.id, 1, currentText));
    const amended = h.store.task(activeTask.id);
    expect(amended.briefPath).not.toBe(originalBriefPath);
    expect(amended.briefPath).not.toBe(initialPath);

    releaseOwnedCheck(activeTask, id);
    await waitFor(join(activeTask.worktree, '.temp/goal/checks/results', `${id}.json`));
    await job.recoverOrphans();

    const resumed = captured(h.store.task(activeTask.id), 1, 'resume');
    const context = contextFromPrompt(resumed.prompt);
    expect(resumed.args).toContain('resume');
    expect(resumed.args).toContain(originalSession!);
    expect(h.store.task(activeTask.id).currentAttempt).toBe(1);
    expect(h.store.attempts(activeTask.id).filter((attempt) => attempt.attempt === 1)).toHaveLength(1);
    expect(h.store.attempt(ref).checks).toEqual(waiting.checks);
    expect(resumed.prompt).toContain(currentText);
    expect(resumed.prompt).not.toContain(initialText);
    expect(resumed.prompt).toContain(
      'This prompt and these facts supersede saved sessions, retry manifests and earlier results.',
    );
    expect(resumed.prompt).toContain(
      'Native marker timestamp unit correction: marker timestamps are epoch microseconds',
    );
    expect(resumed.prompt).toContain('Run the acceptance command in the foreground from the worktree root');
    expect(resumed.prompt).not.toContain(remoteCommand);
    expect(resumed.prompt).not.toContain('The native marker timestamp unit is epoch milliseconds.');
    expect(resumed.prompt).not.toContain('Run the remote campaign');
    expect(resumed.prompt).toContain(`check ${id}: exit status 1; physical remote acceptance failed;`);
    expect(resumed.prompt).toContain(join('.temp/goal/checks', `${id}.log`));
    expect(resumed.prompt).not.toContain('Run `bun scripts/worker-check.ts --wait');
    expect(context).toMatchObject({ boundary: 'wake', task: { id: activeTask.id, attempt: 1 } });
    expect(context.task).toMatchObject({
      contractPath: amended.briefPath,
      contractSha256: hash(currentText),
      contractProof: 'verified',
    });

    const runs = join(activeTask.worktree, '.temp/goal/checks/runs');
    const results = join(activeTask.worktree, '.temp/goal/checks/results');
    expect(readdirSync(runs).filter((name) => name.endsWith('.json'))).toEqual([`${id}.json`]);
    expect(readdirSync(results).filter((name) => name.endsWith('.json'))).toEqual([`${id}.json`]);
    const receipt = JSON.parse(readFileSync(join(results, `${id}.json`), 'utf8')) as {
      exitStatus: number;
      summary: string;
      logPath: string;
    };
    expect(receipt).toMatchObject({ exitStatus: 1, summary: 'physical remote acceptance failed' });
    expect(readFileSync(join(activeTask.worktree, receipt.logPath), 'utf8')).toContain('remote performance receipt');
  } finally {
    if (task) releaseOutstandingChecks(task);
    h.dispose();
  }
});

test('a capacity waiter launches from the latest canonical contract snapshot', async () => {
  const h = harness(provider);
  const capacityPath = join(h.settings.stateDirectory, 'capacity.json');
  let launch: Promise<void> | undefined;
  try {
    const initialText = contractRevision(
      'Initial contract before capacity admission.',
      'bun scripts/initial-local-check.ts',
    );
    const initialPath = fullBrief(h.root, 'capacity-canonical-old', initialText);
    const task = h.tasks.dispatch(initialPath);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    writeFileSync(capacityPath, JSON.stringify({ maxWorkers: 0, minAvailableMiB: 0 }));
    launch = job.start(task.id);
    await waitForCapacityWaiter(h.settings.stateDirectory, task.id);

    const currentText = contractRevision(
      'Capacity-admitted contract: use the latest direct local scripts-only acceptance after waiting.',
      'bun scripts/latest-local-check.ts',
    );
    underLease(h, task.id, () => replaceTaskContract(h, task.id, 0, currentText));
    const currentTask = h.store.task(task.id);
    expect(currentTask.briefPath).not.toBe(initialPath);
    writeFileSync(capacityPath, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    await launch;

    const started = captured(currentTask, 1, 'start');
    const context = contextFromPrompt(started.prompt);
    expect(started.prompt).toContain(currentText);
    expect(started.prompt).not.toContain('Initial contract before capacity admission.');
    expect(context.task).toMatchObject({
      contractPath: currentTask.briefPath,
      contractSha256: hash(currentText),
      contractProof: 'verified',
      attempt: 1,
    });
  } finally {
    if (launch) {
      writeFileSync(capacityPath, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
      await launch.catch(() => {});
    }
    h.dispose();
  }
});

test('a wake without a resumable session uses a full prompt with the current dependency receipt', async () => {
  const h = harness(provider);
  let task: { id: string; worktree: string } | undefined;
  try {
    const dependency = integratedDependency(h, 'nonresumable-dependency.ts');
    const briefPath = amendedBrief(
      h.root,
      'nonresumable-wake',
      dependency.id,
      'BEGIN_WAITING_SESSION\nComplete the task after the actual acceptance check finishes.',
    );
    task = h.tasks.dispatch(briefPath);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);

    const ref = { taskId: task.id, attempt: 1 };
    const waiting = h.store.attempt(ref);
    expect(waiting.state).toBe('waiting');
    const id = waiting.checks![0]!;
    releaseOwnedCheck(task, id);
    await waitFor(join(task.worktree, '.temp/goal/checks/results', `${id}.json`));
    underLease(h, task.id, () =>
      h.store.updateAttempt(ref, (attempt) => {
        attempt.session = null;
      }),
    );

    await job.recoverOrphans();

    const relaunched = captured(h.store.task(task.id), 1, 'start');
    const context = contextFromPrompt(relaunched.prompt);
    expect(relaunched.args).not.toContain('resume');
    expect(relaunched.prompt).toContain(h.store.task(task.id).brief.markdown);
    expect(context).toMatchObject({ boundary: 'wake', origin: 'managed' });
    expect(relaunched.prompt).toContain(`- \`${dependency.id}\`: integrated in your base at \`${dependency.commit}\`.`);
  } finally {
    if (task) releaseOutstandingChecks(task);
    h.dispose();
  }
});

test('a later dependency merge is described truthfully and an unavailable source observation is not described as proven absence', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const prepared = task.base;
    const dependency = h.tasks.dispatch(h.briefFile);
    writeFileSync(join(dependency.worktree, 'later.ts'), 'export const later = true;\n');
    git(dependency.worktree, ['add', 'later.ts']);
    git(dependency.worktree, ['commit', '-m', 'Later dependency']);
    const commit = git(dependency.worktree, ['rev-parse', 'HEAD']);
    h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (current) => {
      current.state = 'integrated';
      current.integratedCommit = commit;
    });
    git(task.worktree, ['merge', '--no-edit', '-m', 'Take later dependency', commit]);
    replaceTaskContract(
      h,
      task.id,
      0,
      readFileSync(amendedBrief(h.root, 'later-merge', dependency.id, 'Use later merge.'), 'utf8'),
    );
    const ref = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (attempt) =>
      fixtureAttempt(task.id, attempt, h.settings.stateDirectory),
    );
    const later = underLease(h, task.id, () => captureLaunchContext(h.store, ref, 'retry'));
    expect(later.task.base).toBe(prepared);
    expect(later.dependencies.receipts[0]).toMatchObject({
      commit,
      sourcePresence: 'present',
      basePresence: 'absent',
      precondition: 'unmet',
    });
    const laterPrompt = renderLaunchContext(later);
    expect(laterPrompt).toContain(
      `- \`${dependency.id}\`: present in current source at \`${commit}\`; not in your prepared base.`,
    );
    expect(laterPrompt).not.toContain(`integrated in your base at \`${commit}\``);

    const foreign = join(h.root, '.temp/goal/unavailable-dependency');
    mkdirSync(foreign, { recursive: true });
    git(foreign, ['init', '-b', 'main']);
    git(foreign, ['config', 'user.email', 'fixture@example.invalid']);
    git(foreign, ['config', 'user.name', 'Fixture']);
    writeFileSync(join(foreign, 'foreign.ts'), 'export const foreign = true;\n');
    git(foreign, ['add', 'foreign.ts']);
    git(foreign, ['commit', '-m', 'Unavailable dependency commit']);
    const unavailable = git(foreign, ['rev-parse', 'HEAD']);
    h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (current) => {
      current.integratedCommit = unavailable;
    });
    const unknown = underLease(h, task.id, () => captureLaunchContext(h.store, ref, 'retry'));
    expect(unknown.dependencies.receipts[0]).toMatchObject({
      sourcePresence: 'unknown',
      basePresence: 'unknown',
      precondition: 'unknown',
    });
    const unknownPrompt = renderLaunchContext(unknown);
    expect(unknownPrompt).toContain(
      `- \`${dependency.id}\`: source observation is unavailable; build against its contract.`,
    );
    expect(unknownPrompt).not.toContain('not in your base');
  } finally {
    h.dispose();
  }
});

test('unknown, cancelled, missing and absent dependency source proofs are never rendered as installed code', async () => {
  const h = harness(provider);
  try {
    const dependency = h.tasks.dispatch(h.briefFile);
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);

    writeFileSync(join(dependency.worktree, 'unmerged.ts'), 'export const unmerged = true;\n');
    git(dependency.worktree, ['add', 'unmerged.ts']);
    git(dependency.worktree, ['commit', '-m', 'Create unmerged dependency source']);
    const dependencyCommit = git(dependency.worktree, ['rev-parse', 'HEAD']);
    h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (current) => {
      current.state = 'integrated';
      current.integratedCommit = dependencyCommit;
    });
    const afterDependency = amendedBrief(h.root, 'source-proof', dependency.id, 'Inspect current source proof.');
    replaceTaskContract(h, task.id, 1, readFileSync(afterDependency, 'utf8'));

    const absent = underLease(h, task.id, () =>
      captureLaunchContext(h.store, { taskId: task.id, attempt: 1 }, 'retry'),
    );
    expect(absent.dependencies.receipts[0]).toMatchObject({
      state: 'integrated',
      completion: 'integrated',
      commit: dependencyCommit,
      sourcePresence: 'absent',
      precondition: 'unmet',
    });
    expect(absent.task.sourceProof).toBe('verified');

    h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (current) => {
      current.state = 'cancelled';
    });
    const cancelled = underLease(h, task.id, () =>
      captureLaunchContext(h.store, { taskId: task.id, attempt: 1 }, 'retry'),
    );
    expect(cancelled.dependencies.receipts[0]).toMatchObject({
      state: 'cancelled',
      completion: 'not-integrated',
      sourcePresence: 'not-checked',
      precondition: 'unmet',
    });

    const foreign = join(h.root, '.temp/goal/foreign-dependency');
    mkdirSync(foreign, { recursive: true });
    git(foreign, ['init', '-b', 'main']);
    git(foreign, ['config', 'user.email', 'fixture@example.invalid']);
    git(foreign, ['config', 'user.name', 'Fixture']);
    writeFileSync(join(foreign, 'foreign.ts'), 'export const foreignDependency = true;\n');
    git(foreign, ['add', 'foreign.ts']);
    git(foreign, ['commit', '-m', 'Create unavailable dependency commit']);
    const unavailableCommit = git(foreign, ['rev-parse', 'HEAD']);
    h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (current) => {
      current.state = 'integrated';
      current.integratedCommit = unavailableCommit;
    });
    const unknownCommit = underLease(h, task.id, () =>
      captureLaunchContext(h.store, { taskId: task.id, attempt: 1 }, 'retry'),
    );
    expect(unknownCommit.dependencies.receipts[0]).toMatchObject({
      state: 'integrated',
      completion: 'integrated',
      commit: unavailableCommit,
      sourcePresence: 'unknown',
      precondition: 'unknown',
    });

    const missingContract = amendedBrief(h.root, 'missing-source-proof', 'missing-task', 'Unknown dependency.');
    replaceTaskContract(h, task.id, 1, readFileSync(missingContract, 'utf8'));
    const missing = underLease(h, task.id, () =>
      captureLaunchContext(h.store, { taskId: task.id, attempt: 1 }, 'retry'),
    );
    expect(missing.dependencies.receipts[0]).toMatchObject({
      id: 'missing-task',
      state: 'missing',
      completion: 'unknown',
      sourcePresence: 'unknown',
      precondition: 'unknown',
    });
    expect(JSON.stringify(missing.dependencies)).not.toContain('"sourcePresence":"present"');

    const taskRef = { taskId: task.id, attempt: 1 };
    underLease(h, task.id, () =>
      h.store.updateTask(taskRef, (current) => {
        current.branch = 'worker/wrong-branch';
      }),
    );
    const badIdentity = underLease(h, task.id, () => captureLaunchContext(h.store, taskRef, 'retry'));
    expect(badIdentity.task.sourceProof).toBe('unknown');
    expect(badIdentity.task.sourceBranch).toBe(task.branch);
    underLease(h, task.id, () =>
      h.store.updateTask(taskRef, (current) => {
        current.branch = task.branch;
      }),
    );

    const oldRef = { taskId: task.id, attempt: 1 };
    const previous = h.store.attempt(oldRef);
    underLease(h, task.id, () =>
      h.store.nextAttempt(oldRef, (attempt) => ({
        ...previous,
        attempt,
        state: 'pending',
        startedAt: new Date().toISOString(),
        endedAt: null,
        process: null,
        driver: null,
        session: null,
        checks: [],
        logPath: join(h.settings.stateDirectory, 'runs', task.id, `${attempt}.jsonl`),
        evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(attempt)),
      })),
    );
    expect(() => underLease(h, task.id, () => captureLaunchContext(h.store, oldRef, 'retry'))).toThrow(
      StaleAttemptError,
    );
  } finally {
    h.dispose();
  }
});

test('adopting an imported legacy attempt emits current metadata in the actual resumed argv', async () => {
  const h = harness(provider);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const logPath = join(h.settings.stateDirectory, 'legacy-session.jsonl');
    writeFileSync(
      logPath,
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'legacy-session' }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'RESULT: historical completion' },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 1 } }),
      ].join('\n') + '\n',
    );
    const now = Date.now();
    importAttempt(h.tasks, logPath, {
      taskId: task.id,
      startedAt: new Date(now - 1000).toISOString(),
      endedAt: new Date(now).toISOString(),
      profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
      pool: 'fixture',
      outcome: 'stopped',
    });

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    const resumed = captured(h.store.task(task.id), 2, 'resume');
    const context = contextFromPrompt(resumed.prompt);
    expect(context).toMatchObject({ boundary: 'adopted-legacy', origin: 'adopted-legacy' });
    expect(context.task).toMatchObject({
      id: task.id,
      attempt: 2,
      contractSha256: hash(task.brief.markdown),
      contractProof: 'verified',
      sourceProof: 'verified',
    });
    expect(JSON.stringify(context)).not.toContain('historical completion');
  } finally {
    h.dispose();
  }
});
