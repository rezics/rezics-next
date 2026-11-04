import { expect, test } from 'bun:test';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPolicy } from './policy.ts';
import {
  applyRenderedPrompt,
  DEFAULT_PROMPT_DIRECTORY,
  fillTemplate,
  renderManagerOpening,
  renderWorkerPrompt,
  type RenderedPrompt,
} from './prompts.ts';
import { assertBriefDispatchable, BRIEF_AUTHORITY_HINT, SUPERSEDED_CHECK_HINT } from './briefs.ts';
import type { Attempt, Brief, PromptManifest, Task } from './types.ts';
import type { ProofReservation } from './verification.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { emptyTokens, makeRecord, type LogMeasurement } from './records.ts';
import { brief, temporaryDirectory } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';
import type { Settings } from './types.ts';
import type { WorkerTasks } from './tasks.ts';

const GOLDEN_DIRECTORY = join(import.meta.dir, '../prompts/golden');
const WORKTREE = '/work/t';
const MAIN = '/repo';
const SOURCE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RETRY_MANIFEST = 'Retry 1: bun test src/a.test.ts exited 1.';

function contract(extra: Partial<Brief> = {}): Brief {
  return {
    goal: 'web',
    manager: 'web',
    kind: 'implementation',
    paths: ['src/a.ts'],
    riskAreas: [],
    markdown: 'Do the thing.',
    acceptance: { command: ['bun', 'test'], tests: ['x'], failing: true },
    estimate: { lines: 100, files: 4 },
    criticalPath: false,
    waiting: [],
    after: [],
    inseparable: false,
    citesSources: false,
    hostileInput: false,
    ...extra,
  };
}

function worker(brief: Brief, extra: Partial<Task> = {}): Task {
  return {
    id: 'task',
    sequence: 1,
    brief,
    briefPath: 'brief.md',
    state: 'ready',
    worktree: WORKTREE,
    branch: 'worker/task',
    base: SOURCE,
    taskClass: brief.kind === 'verification' ? 'implementation' : (brief.kind as Task['taskClass']),
    currentAttempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as Task;
}

function retryEvidence(): string {
  const directory = mkdtempSync(join(tmpdir(), 'prompt-retry-'));
  writeFileSync(join(directory, 'failure.json'), JSON.stringify({ manifest: RETRY_MANIFEST }));
  return directory;
}

function goldenCases(): { name: string; rendered: RenderedPrompt }[] {
  const proofRun: ProofReservation = {
    status: 'bound',
    binding: {
      version: 1,
      reservationToken: 'token',
      checkId: '11111111-1111-4111-8111-111111111111',
      goal: 'web',
      taskId: 'task',
      attempt: 1,
      sourceCommit: SOURCE,
      sourceTree: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      argv: ['bun', 'test'],
      cwd: WORKTREE,
    },
  };
  return [
    {
      name: 'dev-implementation.txt',
      rendered: renderWorkerPrompt({ task: worker(contract()), mainCheckout: MAIN }),
    },
    {
      name: 'interface-stories.txt',
      rendered: renderWorkerPrompt({
        task: worker(
          contract({
            kind: 'interface',
            paths: ['apps/web/src/stories/card.stories.tsx'],
            markdown: 'Polish the card.',
          }),
        ),
        mainCheckout: MAIN,
      }),
    },
    {
      name: 'research.txt',
      rendered: renderWorkerPrompt({
        task: worker(
          contract({
            kind: 'research',
            paths: ['docs/research/x.md'],
            markdown: 'Survey the sources.',
          }),
        ),
        mainCheckout: MAIN,
      }),
    },
    {
      name: 'verification-proof.txt',
      rendered: renderWorkerPrompt({
        task: worker(
          contract({
            kind: 'verification',
            paths: [],
            markdown: 'Read-only original journey.',
            proof: { journey: 'Original', sourceTasks: ['original'], sourceCommit: SOURCE },
          }),
          { proofRun, currentAttempt: 1 },
        ),
        mainCheckout: MAIN,
        proofRun,
      }),
    },
    {
      name: 'shared-workspace.txt',
      rendered: renderWorkerPrompt({
        task: worker(contract({ markdown: 'Share the module.' }), {
          workspace: { module: 'apps/web', taskName: 'library' },
        }),
        mainCheckout: MAIN,
      }),
    },
    {
      name: 'retry-manifest.txt',
      rendered: renderWorkerPrompt({
        task: worker(contract({ markdown: 'Retry the change.' })),
        mainCheckout: MAIN,
        evidence: retryEvidence(),
      }),
    },
  ];
}

test('every template renders within its byte budget for the six golden tasks, and the renders equal the committed golden files', () => {
  const update = process.env.UPDATE_PROMPT_GOLDENS === '1';
  if (update) mkdirSync(GOLDEN_DIRECTORY, { recursive: true });
  for (const { name, rendered } of goldenCases()) {
    const path = join(GOLDEN_DIRECTORY, name);
    const roleBudget =
      name === 'research.txt' ? defaultPolicy.prompt.researchRoleBytes : defaultPolicy.prompt.workerRoleBytes;
    expect(rendered.roleBytes).toBeLessThanOrEqual(roleBudget);
    expect(rendered.conditionBytes).toBeLessThanOrEqual(defaultPolicy.prompt.conditionBytes);
    expect(rendered.manifest.layers.total).toBeLessThanOrEqual(defaultPolicy.prompt.workerTotalBytes);
    expect(rendered.manifest.overBudget).toEqual([]);
    if (name === 'dev-implementation.txt')
      expect(rendered.roleBytes + rendered.conditionPromptBytes).toBeLessThanOrEqual(5000);
    if (update) writeFileSync(path, rendered.prompt);
    expect(rendered.prompt).toBe(readFileSync(path, 'utf8'));
  }
});

test('a worker render over its budgets launches with layer sizes, budgets and over-budget names', () => {
  const policy = {
    ...defaultPolicy,
    brief: { ...defaultPolicy.brief, bytes: 1 },
    prompt: { ...defaultPolicy.prompt, workerRoleBytes: 10, conditionBytes: 10, workerTotalBytes: 10 },
  };
  const rendered = renderWorkerPrompt({ task: worker(contract()), mainCheckout: MAIN, policy });
  expect(rendered.manifest.budgets).toEqual({ role: 10, conditions: 10, brief: 1, total: 10 });
  expect(rendered.manifest.layers).toEqual({
    role: rendered.roleBytes,
    conditions: rendered.conditionBytes,
    brief: rendered.briefBytes,
    total: Buffer.byteLength(rendered.prompt),
  });
  expect(rendered.manifest.overBudget).toEqual(['role', 'conditions', 'brief', 'total']);
});

test('manager role templates keep their budget and oversized manager renders launch with measurements', () => {
  const input = {
    spec: { id: 'manager', goal: 'fixture', brief: 'Manage the fixture.', cwd: '/missing', engine: 'codex' as const },
    backlogPath: '/backlog',
    command: 'goal',
  };
  const standard = renderManagerOpening(input);
  expect(standard.roleBytes).toBeLessThanOrEqual(defaultPolicy.prompt.managerRoleBytes);
  const rendered = renderManagerOpening({
    ...input,
    policy: {
      ...defaultPolicy,
      prompt: { ...defaultPolicy.prompt, managerRoleBytes: 1, managerOpeningBytes: 1 },
    },
  });
  expect(rendered.manifest.layers).toEqual({ role: rendered.roleBytes, opening: rendered.openingBytes });
  expect(rendered.manifest.budgets).toEqual({ role: 1, opening: 1 });
  expect(rendered.manifest.overBudget).toEqual(['role', 'opening']);
});

test('a minimal-verification launch of a brief that requires browser checks records deferredAcceptance and names that item', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prompt-minimal-'));
  try {
    writeFileSync(join(directory, 'verification-mode'), 'minimal\n');
    const rendered = renderWorkerPrompt({
      task: worker(
        contract({
          kind: 'interface',
          paths: ['apps/web/src/stories/card.stories.tsx'],
          markdown: 'Polish the card.',
        }),
      ),
      mainCheckout: MAIN,
      stateDirectory: directory,
    });
    expect(rendered.deferredAcceptance).toEqual(['browser']);
    expect(rendered.prompt).toContain('browser is deferred to the verifier.');
    expect(rendered.prompt).not.toMatch(/overrides (contract|the brief)|policy overrides/i);
    const attempt = { prompt: undefined as PromptManifest | undefined };
    const task = { deferredAcceptance: undefined as Task['deferredAcceptance'] };
    applyRenderedPrompt(
      {
        updateAttempt(_ref, update) {
          update(attempt as Attempt);
          return attempt as Attempt;
        },
        updateTask(_ref, update) {
          update(task as Task);
          return task as Task;
        },
      },
      { taskId: 'task', attempt: 1 },
      rendered,
    );
    expect(task.deferredAcceptance).toEqual(['browser']);
    expect(attempt.prompt).toEqual(rendered.manifest);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dispatch lints report local state, main checkout and superseded check instructions without refusal', () => {
  expect(assertBriefDispatchable('See `.temp/goal/notes.md`.')[0]).toContain(BRIEF_AUTHORITY_HINT);
  expect(assertBriefDispatchable(`Keep files under ${MAIN}.`, MAIN)[0]).toContain(BRIEF_AUTHORITY_HINT);
  expect(
    assertBriefDispatchable('A saved worker prompt used `bun scripts/worker-check.ts -- <command...>` and `--wait`.')[0],
  ).toContain(SUPERSEDED_CHECK_HINT);
});

test('a new attempt record holds the prompt manifest, and attempts --json exports it', async () => {
  const directory = temporaryDirectory();
  const db = openDb(':memory:');
  try {
    const store = new WorkerStore(db);
    const task = store.createTask(
      brief(),
      { briefPath: join(directory.path, 'brief.md'), worktree: WORKTREE, branch: 'worker/task', base: SOURCE },
      'implementation',
      'task',
    );
    const attempt = {
      taskId: task.id,
      attempt: 1,
      state: 'exited',
      profile: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', poolClass: 'default' },
      pool: 'fixture',
      tableVersion: '1',
      experiment: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      process: null,
      driver: null,
      logPath: 'log',
      evidencePath: 'evidence',
      auxiliaryProcesses: [],
      session: null,
      fixRound: 0,
      consulted: false,
      previousFailure: null,
      failure: null,
      escalation: null,
      before: null,
      after: null,
      exitCode: 0,
      result: '',
      blocker: null,
      approaches: [],
    } as Attempt;
    db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
      task.id,
      1,
      JSON.stringify(attempt),
    );
    db.query("UPDATE worker_tasks SET current_attempt=1, body=json_set(body, '$.currentAttempt', 1) WHERE id=?").run(
      task.id,
    );
    const live = new WorkerStore(db);
    const rendered = renderWorkerPrompt({ task: worker(contract()), mainCheckout: MAIN });
    applyRenderedPrompt(live, { taskId: task.id, attempt: 1 }, rendered);
    expect(live.attempt({ taskId: task.id, attempt: 1 }).prompt).toEqual(rendered.manifest);
    const measurement: LogMeasurement = {
      tokens: emptyTokens(),
      total: emptyTokens(),
      usage: null,
      steps: { decision: 0, read: 0, edit: 0, wait: 0, check: 0, commit: 0 },
      session: null,
      result: '',
      blocker: null,
      failureKind: null,
      usageLimitRefusal: false,
      waitingChecks: null,
    };
    live.putRecord(makeRecord(live.task(task.id), live.attempt({ taskId: task.id, attempt: 1 }), measurement));
    const output: string[] = [];
    const code = await runWorkerCommand('attempts', ['--json'], {
      settings: { stateDirectory: directory.path } as Settings,
      tasks: { settings: { stateDirectory: directory.path }, store: live } as unknown as WorkerTasks,
      store: live,
      env: {},
      print: (value) => output.push(value),
    });
    expect(code).toBe(0);
    expect(JSON.parse(output[0]!)[0].prompt).toEqual(rendered.manifest);
  } finally {
    db.close();
    directory.close();
  }
});

test('editing a template file changes the next render without restarting or reloading the module', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prompt-templates-'));
  try {
    mkdirSync(join(directory, 'conditions'));
    for (const name of ['worker.md', 'research.md', 'manager.md'])
      copyFileSync(join(DEFAULT_PROMPT_DIRECTORY, name), join(directory, name));
    for (const name of readdirSync(join(DEFAULT_PROMPT_DIRECTORY, 'conditions')))
      copyFileSync(join(DEFAULT_PROMPT_DIRECTORY, 'conditions', name), join(directory, 'conditions', name));
    const input = { task: worker(contract()), mainCheckout: MAIN, promptDirectory: directory };
    const first = renderWorkerPrompt(input);
    appendFileSync(join(directory, 'worker.md'), '\nLIVE-RELOAD-MARKER\n');
    const second = renderWorkerPrompt(input);
    expect(first.prompt).not.toContain('LIVE-RELOAD-MARKER');
    expect(second.prompt).toContain('LIVE-RELOAD-MARKER');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unknown placeholder is an error', () => {
  expect(() => fillTemplate('Hello {{task.missing}}', { id: 'task' }, defaultPolicy)).toThrow(
    'unknown placeholder {{task.missing}}',
  );
});
