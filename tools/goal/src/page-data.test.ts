import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from './db.ts';
import { flowReport, formatPageDataFlowRuns, readFlow } from './flow.ts';
import { WorkerJob } from './job.ts';
import { routePageDataRepair } from './config.ts';
import { SqliteManagerInbox } from './inbox.ts';
import {
  duePageDataRun,
  latestSectionOwner,
  newlyDefectiveSections,
  pageDataClassCounts,
  parsePageDataOutput,
  PageDataStackError,
  firstSubstantiveErrorLine,
  terminalErrorLine,
  runPageDataCycle,
  type PageDataSection,
  type PageDataRepair,
  type SectionConfig,
} from './page-data.ts';
import type { Settings, Task } from './types.ts';
import { harness } from './test-support.ts';
import { readControlPolicy } from './policy.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goal-page-data-'));
  roots.push(root);
  const mainCheckout = join(root, 'repo');
  mkdirSync(mainCheckout, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: mainCheckout, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'dev');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Page data test');
  writeFileSync(join(mainCheckout, 'tracked.txt'), 'fixture\n');
  git('add', 'tracked.txt');
  git('commit', '-m', 'base');
  const stateDirectory = join(root, 'state');
  mkdirSync(stateDirectory, { recursive: true });
  const settings = {
    mainCheckout,
    stateDirectory,
    worktreeRoot: join(root, 'worktrees'),
    integrationBranch: 'dev',
    integration: { supermanager: 'supermanager' },
    policy: { pageData: { intervalMs: 1 } },
  } as unknown as Settings;
  const source: SectionConfig = {
    page: 'home',
    persona: 'anonymous',
    section: 'feed',
    name: 'Feed',
    goal: 'web',
    files: ['apps/web/src/routes/index.tsx'],
  };
  const registry = new Map([[`${source.page}\t${source.persona}\t${source.section}`, source]]);
  const db = openDb(join(stateDirectory, 'state.sqlite'));
  return { root, settings, source, registry, db };
}

const section = (className: PageDataSection['class']): PageDataSection => ({
  page: 'home',
  persona: 'anonymous',
  section: 'feed',
  name: 'Feed',
  class: className,
  goal: 'web',
  files: ['apps/web/src/routes/index.tsx'],
  ...(className === 'API' ? { firstErrorLine: 'home anonymous feed API' } : {}),
});

test('page-data diagnostics skip command echoes, retain useful log references, and redact credentials', () => {
  expect(
    firstSubstantiveErrorLine(
      '$ bun scripts/database.ts up\ntask: [database] bun scripts/database.ts up\nerror: role "rezics" does not exist\nsee /tmp/stack.log',
    ),
  ).toBe('error: role "rezics" does not exist; see /tmp/stack.log');
  expect(firstSubstantiveErrorLine('$ bun scripts/database.ts up\npassword=supersecret failed to bind')).toBe(
    '[redacted] failed to bind',
  );
});

test('terminal stack diagnostics prefer the process-ending error over surviving retry failures', () => {
  expect(
    terminalErrorLine(
      [
        'Account discovery redrive failed 39 | retrying in the background',
        '$ bun --watch src/server.ts',
        'task: [server] bun --watch src/server.ts',
        'fatal: kernel listener exited after address already in use',
      ].join('\n'),
    ),
  ).toBe('fatal: kernel listener exited after address already in use');
});

test('the policy interval, defect transition, section output and per-run report preserve page classes', async () => {
  const h = fixture();
  try {
    const start = new Date('2026-01-01T00:00:00.000Z');
    expect(duePageDataRun(start.toISOString(), start.getTime() + 1, 2)).toBe(false);
    expect(duePageDataRun(start.toISOString(), start.getTime() + 2, 2)).toBe(true);
    expect(readControlPolicy().pageData.intervalMs).toBe(7_200_000);
    expect(readControlPolicy({ containers: { keep: ['rezics-pagecheck-'] } }).containers.keep).toContain(
      'rezics-pagecheck-',
    );
    expect(pageDataClassCounts([section('DATA'), section('API')])).toMatchObject({ DATA: 1, API: 1, WEB: 0 });
    expect(newlyDefectiveSections([section('EMPTY')], [section('API')])).toEqual([
      { section: section('API'), previousClass: 'EMPTY' },
    ]);
    expect(
      parsePageDataOutput('home anonymous feed API\n', h.registry).map(({ class: value, firstErrorLine }) => [
        value,
        firstErrorLine,
      ]),
    ).toEqual([['API', 'home anonymous feed API']]);

    const routed: string[] = [];
    let result = 'home anonymous feed DATA\n';
    const options = {
      settings: h.settings,
      db: h.db,
      tasks: { tasks: () => [] },
      inbox: { deliver() {} },
      now: () => start,
      runStack: async () => ({ output: result, exitCode: 0, registry: h.registry }),
      routeDefect: async ({
        section: defective,
        previousClass,
      }: {
        section: PageDataSection;
        previousClass: string;
      }) => {
        routed.push(`${defective.class}:${previousClass}`);
        return 'dispatched' as const;
      },
    };
    expect(await runPageDataCycle(options)).toBe('ran');
    result = 'home anonymous feed API\n';
    let now = new Date(start.getTime() + 2);
    options.now = () => now;
    expect(await runPageDataCycle(options)).toBe('ran');
    now = new Date(start.getTime() + 4);
    expect(await runPageDataCycle(options)).toBe('ran');
    expect(routed).toEqual(['API:DATA']);
    const pageDataRuns = flowReport(readFlow(h.db), [], now.getTime()).pageDataRuns;
    expect(pageDataRuns.at(-1)).toMatchObject({
      classes: { API: 1, DATA: 0 },
      sections: { API: [{ page: 'home', section: 'feed', class: 'API' }] },
    });
    expect(formatPageDataFlowRuns(pageDataRuns).join('\n')).toContain('API (1): home/anonymous/feed');
  } finally {
    h.db.close();
  }
});

test('a readiness failure reaches the supermanager with its last probe and the saved stack log', async () => {
  const h = fixture();
  try {
    const notices: { managerId: string; kind: string; summary: string }[] = [];
    const now = new Date('2026-01-01T00:00:00.000Z');
    const output = 'Account discovery redrive failed during a retry\nstack stayed alive\n';
    const readinessFailure = 'http://127.0.0.1:4401/health returned HTTP 503';
    const result = await runPageDataCycle({
      settings: h.settings,
      db: h.db,
      tasks: { tasks: () => [] },
      inbox: { deliver: (notice) => notices.push(notice) },
      now: () => now,
      runStack: async () => {
        throw new PageDataStackError('boot', 'stack did not become ready', readinessFailure, output);
      },
      routeDefect: async () => 'dispatched',
    });
    expect(result).toBe('failed');
    expect(notices).toEqual([
      {
        managerId: 'supermanager',
        kind: 'environment',
        summary: expect.stringContaining(readinessFailure),
      },
    ]);
    const logPath = notices[0]!.summary.match(/output log: (.+)$/)?.[1];
    expect(logPath?.startsWith(join(h.settings.stateDirectory, 'page-data-failures'))).toBe(true);
    expect(readFileSync(logPath!, 'utf8')).toBe(output);
    expect(flowReport(readFlow(h.db), []).pageDataRuns[0]?.failure).toEqual({
      phase: 'boot',
      firstErrorLine: readinessFailure,
    });
  } finally {
    h.db.close();
  }
});

test('a page-data check failure saves the stack and check output and names the log', async () => {
  const h = fixture();
  try {
    const notices: { managerId: string; kind: string; summary: string }[] = [];
    const stackOutput = 'stack stays up while the account redrive retries\n';
    const checkOutput =
      'background retry failed but the stack survived\nerror: page-data check exited on a failed request\n';
    const result = await runPageDataCycle({
      settings: h.settings,
      db: h.db,
      tasks: { tasks: () => [] },
      inbox: { deliver: (notice) => notices.push(notice) },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      runStack: async () => ({ output: checkOutput, stackOutput, exitCode: 2, registry: h.registry }),
      routeDefect: async () => 'dispatched',
    });

    expect(result).toBe('failed');
    expect(notices[0]?.summary).toContain('error: page-data check exited on a failed request');
    const logPath = notices[0]?.summary.match(/output log: (.+)$/)?.[1];
    expect(logPath?.startsWith(join(h.settings.stateDirectory, 'page-data-failures'))).toBe(true);
    const log = readFileSync(logPath!, 'utf8');
    expect(log).toContain(stackOutput);
    expect(log).toContain(checkOutput);
  } finally {
    h.db.close();
  }
});

test('the latest integrated task that changed a mapped section file owns its defect', () => {
  const task = (id: string, commit: string, sequence: number) =>
    ({
      id,
      sequence,
      state: 'integrated',
      integratedCommits: [commit],
      brief: { goal: 'web', manager: 'web' },
    }) as Task;
  expect(
    latestSectionOwner(
      [task('older', 'a', 1), task('newer', 'b', 2)],
      [
        { commit: 'a', position: 0, files: ['apps/web/src/routes/index.tsx'] },
        { commit: 'b', position: 1, files: ['apps/web/src/routes/search.tsx'] },
      ],
      ['apps/web/src/routes/index.tsx', 'apps/web/src/routes/**'],
    )?.id,
  ).toBe('newer');
});

test('an integrated author task resumes its retained provider session with the section evidence', async () => {
  const script = `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const resumed = args.includes('resume');
mkdirSync('.temp', { recursive: true });
writeFileSync('.temp/page-data-launch.json', JSON.stringify(args));
writeFileSync('result.txt', resumed ? 'repaired' : 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-qm', resumed ? 'Repair page-data section' : 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'page-data-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
  const h = harness(script);
  const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id);
    const ref = { taskId: task.id, attempt: h.store.task(task.id).currentAttempt };
    h.store.updateTask(ref, (current) => {
      current.state = 'integrated';
    });
    const repairKey = 'a'.repeat(64);
    const taskIds = h.store.tasks().map(({ id }) => id);
    expect(
      await routePageDataRepair(h.tasks, h.store, job, { deliver() {} }, h.settings, {
        repairKey,
        head: 'integrated-head',
        previousClass: 'DATA',
        section: {
          page: 'home',
          persona: 'anonymous',
          section: 'feed',
          name: 'Feed',
          class: 'API',
          goal: 'web',
          files: ['apps/web/src/routes/index.tsx'],
          firstErrorLine: 'home anonymous feed API',
        },
        owner: h.store.task(task.id),
      }),
    ).toBe('resumed');
    await job.drain();
    expect(h.store.tasks().map(({ id }) => id)).toEqual(taskIds);
    expect(h.store.task(task.id).currentAttempt).toBe(ref.attempt + 1);
    const launch = JSON.parse(readFileSync(join(task.worktree, '.temp/page-data-launch.json'), 'utf8')) as string[];
    expect(launch.slice(launch.indexOf('resume'), launch.indexOf('resume') + 2)).toEqual([
      'resume',
      'page-data-session',
    ]);
    const evidence = readFileSync(join(h.settings.stateDirectory, 'page-data-repairs', `${repairKey}.md`), 'utf8');
    expect(evidence).toContain('Class: API (previously DATA)');
    expect(evidence).toContain('First error line: home anonymous feed API');
    expect(h.store.events(task.id, 2).some((event) => event.kind === 'page-data-repair')).toBe(true);
  } finally {
    await h.disposeAsync();
  }
});

test('a non-resumable author task gets one Goal repair task for the cause', async () => {
  const h = harness();
  const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  const inbox = new SqliteManagerInbox(h.store.db, h.settings.stateDirectory);
  try {
    const original = h.tasks.dispatch(h.briefFile);
    const ref = { taskId: original.id, attempt: original.currentAttempt };
    h.store.updateTask(ref, (current) => {
      current.state = 'integrated';
    });
    const owner = h.store.task(original.id);
    const repair: PageDataRepair = {
      repairKey: 'b'.repeat(64),
      head: 'integrated-head',
      previousClass: 'UNAVAILABLE',
      owner,
      section: {
        page: 'home',
        persona: 'anonymous',
        section: 'feed',
        name: 'Feed',
        class: 'API',
        goal: owner.brief.goal,
        files: ['apps/web/src/routes/index.tsx'],
        firstErrorLine: 'home anonymous feed API',
      },
    };
    expect(await routePageDataRepair(h.tasks, h.store, job, inbox, h.settings, repair)).toBe('dispatched');
    expect(await routePageDataRepair(h.tasks, h.store, job, inbox, h.settings, repair)).toBe('dispatched');
    const repairs = h.store
      .tasks()
      .filter((task) => task.brief.markdown.includes(`page-data-repair-key: ${repair.repairKey}`));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.brief.goal).toBe(owner.brief.goal);
    expect(repairs[0]?.brief.manager).toBe(owner.brief.manager);
    expect(repairs[0]?.brief.markdown).toContain('in class `API` (previously `UNAVAILABLE`)');
    expect(inbox.read(owner.brief.manager).map(({ event }) => event)).toContainEqual({
      managerId: owner.brief.manager,
      taskId: repairs[0]!.id,
      goalId: owner.brief.goal,
      kind: 'instruction',
      summary: 'Seeded page-data repair for home/feed: API; first error line: home anonymous feed API.',
    });
  } finally {
    await h.disposeAsync();
  }
});
