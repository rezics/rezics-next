import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { openDb } from './db.ts';
import { flowReport, formatPageDataFlowRuns, readFlow } from './flow.ts';
import { WorkerJob } from './job.ts';
import { routePageDataRepair } from './config.ts';
import { SqliteManagerInbox } from './inbox.ts';
import {
  waitForStack,
  type PageDataCapture,
  duePageDataRun,
  latestSectionOwner,
  newlyDefectiveSections,
  pageDataClassCounts,
  parsePageDataOutput,
  parsePageDataCompletion,
  pageDataSeedStatus,
  pageDataCheckScopeArguments,
  pageDataCheckScopeUnit,
  PageDataStackError,
  firstSubstantiveErrorLine,
  terminalErrorLine,
  runPageDataCycle,
  reconcilePageDataRepairs,
  readLatestPageDataRun,
  type PageDataSection,
  type PageDataUnrunEvidence,
  type PageDataRepair,
  type SectionConfig,
  dependencyFilesChanged,
  reconcileDedicatedPageDataDefinitions,
} from './page-data.ts';
import type { Settings, Task } from './types.ts';
import { harness } from './test-support.ts';
import { readControlPolicy } from './policy.ts';
import { CHECK_SLICE, WORKER_SCOPE_MEMORY_MAX } from './worker-slice.ts';

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
  return { root, settings, source, registry, db, git };
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

const completed = (invocation: string, rows: string, incomplete = false) =>
  rows +
  `Page-data completed ${JSON.stringify({
    version: 1,
    invocation,
    sections: rows.trim().split('\n').length,
    defects: rows.split('\n').filter((row) => / (API|WEB|SEED)(?:\s|$)/.test(row)).length,
    incomplete,
  })}\n`;

test('page-data refresh notices declared dependency patch changes but reuses unrelated source updates', () => {
  const h = fixture();
  try {
    const patchPath = 'patches/@dbos-inc%2Fdbos-sdk@5.5.3-preview.patch';
    mkdirSync(join(h.root, 'repo', 'patches'), { recursive: true });
    writeFileSync(
      join(h.root, 'repo', 'package.json'),
      JSON.stringify({ patchedDependencies: { '@dbos-inc/dbos-sdk@5.5.3-preview': patchPath } }) + '\n',
    );
    writeFileSync(join(h.root, 'repo', 'bun.lock'), 'pinned dependencies\n');
    writeFileSync(join(h.root, 'repo', patchPath), 'first pinned package patch\n');
    h.git('add', 'package.json', 'bun.lock', patchPath);
    h.git('commit', '-m', 'Seed a declared dependency patch');
    const installed = h.git('rev-parse', 'HEAD');

    writeFileSync(join(h.root, 'repo', patchPath), 'updated pinned package patch\n');
    h.git('add', patchPath);
    h.git('commit', '-m', 'Update a declared dependency patch');
    const patched = h.git('rev-parse', 'HEAD');
    expect(dependencyFilesChanged(join(h.root, 'repo'), installed, patched)).toBe(true);

    mkdirSync(join(h.root, 'repo', 'src'), { recursive: true });
    writeFileSync(join(h.root, 'repo', 'src/unrelated.ts'), 'export const value = 1;\n');
    h.git('add', 'src/unrelated.ts');
    h.git('commit', '-m', 'Update unrelated page-data source');
    expect(dependencyFilesChanged(join(h.root, 'repo'), patched, h.git('rev-parse', 'HEAD'))).toBe(false);
  } finally {
    h.db.close();
  }
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

test('a completed run retains bounded native problem evidence but rejects extra response fields', () => {
  const h = fixture();
  try {
    const row = (problem: object, kind = 'API') =>
      `home anonymous feed ${kind} nativeProblem=${encodeURIComponent(JSON.stringify(problem))}\n`;
    const problem = { code: 'deadline_exceeded', pointer: '/query/limit' };
    expect(parsePageDataOutput(row(problem), h.registry)[0]?.nativeProblem).toEqual(problem);
    expect(parsePageDataOutput(row({ code: 'index_not_ready' }, 'UNAVAILABLE'), h.registry)[0]?.nativeProblem).toEqual({
      code: 'index_not_ready',
    });
    expect(() => parsePageDataOutput(row({ ...problem, body: 'untrusted' }), h.registry)).toThrow(
      'invalid page-data native problem evidence',
    );
    expect(() => parsePageDataOutput(row(problem, 'DATA'), h.registry)).toThrow('invalid page-data evidence');
  } finally {
    h.db.close();
  }
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
    const unrunEvidence = {
      version: 1,
      provider: 'bangumi',
      sourceKey: 'character:4',
      nativeType: 'wd:Q95074',
      artifact: '../page-data-stack/.temp/cross-media-seed/result.json',
      collection: 'readings',
      reason: 'identity-invalid',
      probes: { web: 'unrun', native: 'unrun', sql: 'unrun' },
    } as const;
    const unrunRow = `home anonymous feed UNAVAILABLE unrun=${encodeURIComponent(JSON.stringify(unrunEvidence))}\n`;
    expect(parsePageDataOutput(unrunRow, h.registry)[0]?.unrun).toEqual(unrunEvidence);
    expect(
      parsePageDataCompletion(completed('identity', unrunRow, true), h.registry, 'identity', 2).sections[0]?.unrun,
    ).toEqual(unrunEvidence);

    const routed: string[] = [];
    let result = 'home anonymous feed DATA\n';
    const options = {
      settings: h.settings,
      db: h.db,
      tasks: { tasks: () => [] },
      inbox: { deliver() {} },
      now: () => start,
      runStack: async (_head: string, invocation: string) => ({
        output: completed(invocation, result),
        exitCode: result.includes(' API') ? 1 : 0,
        registry: h.registry,
      }),
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

test('an incomplete run retains evidence while a legacy risk refusal is reconciled once without rerunning the checker', async () => {
  const h = harness();
  try {
    const integrationRef = spawnSync('git', ['branch', 'dev', 'main'], {
      cwd: h.settings.mainCheckout,
      encoding: 'utf8',
    });
    expect(integrationRef.status).toBe(0);
    const start = new Date('2026-01-01T00:00:00.000Z');
    const interval = h.settings.policy?.pageData?.intervalMs ?? 7_200_000;
    const registry = new Map<string, SectionConfig>([
      [
        'settings\tanonymous\tpermissions',
        {
          page: 'settings',
          persona: 'anonymous',
          section: 'permissions',
          name: 'Permissions',
          goal: 'web',
          files: ['services/auth/src/authorization/permissions.ts'],
        },
      ],
      [
        'home\tanonymous\tfeed',
        {
          page: 'home',
          persona: 'anonymous',
          section: 'feed',
          name: 'Feed',
          goal: 'web',
          files: ['apps/web/src/routes/index.tsx'],
        },
      ],
    ]);
    let rows = 'settings anonymous permissions DATA\nhome anonymous feed DATA\n';
    let currentTime = start;
    let stackRuns = 0;
    const routeAttempts: string[] = [];
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    const job = { resumePageDataRepair: async () => false };
    let legacyGenerator = true;
    let refusedBriefPath = '';
    const dispatch = {
      dispatch(...args: Parameters<typeof h.tasks.dispatch>) {
        const path = args[0];
        const brief = readFileSync(path, 'utf8');
        if (legacyGenerator && brief.includes('settings/anonymous/permissions')) {
          refusedBriefPath = path;
          writeFileSync(path, brief.replace(/"riskAreas": \[\s*"authorization"\s*\]/, '"riskAreas": []'));
        }
        return h.tasks.dispatch(...args);
      },
    };
    const options = {
      settings: h.settings,
      db: h.store.db,
      tasks: { tasks: () => [] },
      inbox,
      now: () => currentTime,
      runStack: async (_head: string, invocation: string) => {
        stackRuns++;
        return {
          output: completed(invocation, rows, rows.includes(' API')),
          exitCode: rows.includes(' API') ? 1 : 0,
          registry,
        };
      },
      routeDefect: (repair: PageDataRepair) => {
        routeAttempts.push(repair.section.section);
        return routePageDataRepair(dispatch, h.store, job, inbox, h.settings, repair);
      },
    };

    expect(await runPageDataCycle(options)).toBe('ran');
    currentTime = new Date(start.getTime() + interval);
    rows = 'settings anonymous permissions API\nhome anonymous feed API\n';
    expect(await runPageDataCycle(options)).toBe('ran');

    expect(routeAttempts).toEqual(['permissions', 'feed']);
    expect(stackRuns).toBe(2);
    expect(readLatestPageDataRun(h.store.db)).toMatchObject({
      coverage: { status: 'incomplete' },
      sections: [
        {
          page: 'settings',
          section: 'permissions',
          class: 'API',
          files: ['services/auth/src/authorization/permissions.ts'],
        },
        { page: 'home', section: 'feed', class: 'API' },
      ],
    });
    const retainedRunId = readLatestPageDataRun(h.store.db)!.runId;
    const report = flowReport(readFlow(h.store.db), []).pageDataRuns.find((item) => item.runId === retainedRunId)!;
    expect(report.repairs).toEqual([
      expect.objectContaining({
        route: 'refused',
        reason: 'declared paths touch undeclared risk area: authorization',
        section: expect.objectContaining({ page: 'settings', section: 'permissions', class: 'API' }),
      }),
      expect.objectContaining({
        route: 'dispatched',
        section: expect.objectContaining({ page: 'home', section: 'feed', class: 'API' }),
      }),
    ]);
    expect(formatPageDataFlowRuns([report]).join('\n')).toContain(
      'Repair refused for settings/anonymous/permissions (API): declared paths touch undeclared risk area: authorization',
    );
    const claims = h.store.db.query('SELECT status,detail FROM page_data_repairs').all() as {
      status: string;
      detail: string;
    }[];
    expect(claims.map(({ status }) => status).sort()).toEqual(['refused', 'routed']);
    expect(claims.map(({ detail }) => JSON.parse(detail))).toContainEqual(
      expect.objectContaining({
        route: 'refused',
        reason: 'declared paths touch undeclared risk area: authorization',
        section: expect.objectContaining({ files: ['services/auth/src/authorization/permissions.ts'] }),
      }),
    );
    expect(h.store.tasks().filter((task) => task.brief.markdown.includes('page-data-repair-key:'))).toHaveLength(1);
    expect(inbox.read('web')).toHaveLength(1);

    expect(await runPageDataCycle(options)).toBe('skipped');
    expect(stackRuns).toBe(2);
    expect(routeAttempts).toEqual(['permissions', 'feed']);
    expect(h.store.tasks().filter((task) => task.brief.markdown.includes('page-data-repair-key:'))).toHaveLength(1);
    expect(inbox.read('web')).toHaveLength(1);

    legacyGenerator = false;
    const run = readLatestPageDataRun(h.store.db)!;
    const originalBrief = readFileSync(refusedBriefPath, 'utf8');
    expect(originalBrief).toContain('"riskAreas": []');
    writeFileSync(refusedBriefPath, originalBrief + '\nUnexpected content change\n');
    expect(await reconcilePageDataRepairs(options, run.runId)).toMatchObject({
      routed: 0,
      unresolved: [expect.objectContaining({ reason: 'page-data repair brief changed for an existing cause' })],
    });
    writeFileSync(refusedBriefPath, originalBrief);
    expect(await reconcilePageDataRepairs(options, run.runId)).toEqual({ routed: 1, unresolved: [] });
    expect(await reconcilePageDataRepairs(options, run.runId)).toEqual({ routed: 0, unresolved: [] });
    expect(readLatestPageDataRun(h.store.db)).toEqual(run);
    expect(stackRuns).toBe(2);
    const retained = h.store.tasks().filter((task) => task.brief.markdown.includes('page-data-repair-key:'));
    expect(retained).toHaveLength(2);
    expect(
      retained.find((task) => task.brief.markdown.includes('settings/anonymous/permissions'))?.brief.riskAreas,
    ).toEqual(['authorization']);
    expect(h.store.db.query("SELECT count(*) AS count FROM page_data_repairs WHERE status='routed'").get()).toEqual({
      count: 2,
    });
  } finally {
    await h.disposeAsync();
  }
});

test('fresh incomplete seed artifacts permit route checks while boot failures and stale files stay stops', async () => {
  const h = fixture();
  try {
    const artifact = join(h.root, '.temp/cross-media-seed/result.json');
    mkdirSync(join(h.root, '.temp/cross-media-seed'), { recursive: true });
    const artifactBytes = '{"published":507,"omissions":[{"code":"legacy-candidate-not-exact"}]}';
    writeFileSync(artifact, artifactBytes);
    const handoff = `Cross-media seed artifact handoff ${JSON.stringify({
      version: 2,
      state: 'publication-incomplete',
      artifact,
      artifactSha256: createHash('sha256').update(artifactBytes).digest('hex'),
      omissions: 1,
    })}`;
    const seed = pageDataSeedStatus(1, `${handoff}\nCross-media seed publication incomplete`, artifact);
    expect(seed).toEqual({ status: 'publication-incomplete', omissions: 1 });
    if (!seed) throw new Error('expected the fresh incomplete artifact handoff');
    expect(pageDataSeedStatus(0, 'Cross-media seed completed', artifact)).toBeUndefined();
    expect(() => pageDataSeedStatus(1, 'Error: issuer boot failed', artifact)).toThrow(PageDataStackError);
    expect(() => pageDataSeedStatus(1, handoff, `${artifact}.stale`)).toThrow('did not match this fresh result');
    expect(() => pageDataSeedStatus(2, handoff, artifact)).toThrow(
      'without an admitted publication-incomplete artifact handoff',
    );

    const result = await runPageDataCycle({
      settings: h.settings,
      db: h.db,
      tasks: { tasks: () => [] },
      inbox: { deliver() {} },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      runStack: async (_head, invocation) => ({
        output: completed(invocation, 'home anonymous feed DATA\n'),
        exitCode: 0,
        registry: h.registry,
        seed,
      }),
      routeDefect: async () => 'dispatched',
    });
    expect(result).toBe('ran');
    expect(readLatestPageDataRun(h.db)).toMatchObject({
      seed,
      sections: [{ page: 'home', section: 'feed', class: 'DATA' }],
    });
    expect(flowReport(readFlow(h.db), []).pageDataRuns[0]).toMatchObject({ seed });
    expect(formatPageDataFlowRuns(flowReport(readFlow(h.db), []).pageDataRuns).join('\n')).toContain(
      'seed=publication-incomplete omissions=1',
    );

    writeFileSync(artifact, '{"old":true}');
    expect(() => pageDataSeedStatus(1, handoff, artifact)).toThrow('artifact digest did not match its handoff');
    expect(() => pageDataSeedStatus(1, 'Cross-media seed failed', artifact)).toThrow(
      'without an admitted publication-incomplete artifact handoff',
    );
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

test('only a matching completed check retains partial evidence and records coverage separately from seed', async () => {
  const h = fixture();
  try {
    const notices: { summary: string }[] = [];
    const seed = { status: 'publication-incomplete' as const, omissions: 2 };
    const rows = 'home anonymous feed API\n';
    const options = {
      settings: h.settings,
      db: h.db,
      tasks: { tasks: () => [] },
      inbox: {
        deliver: (notice: { summary: string }) => {
          notices.push(notice);
        },
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      runStack: async (_head: string, invocation: string) => ({
        output: completed(invocation, rows, true),
        exitCode: 1,
        registry: h.registry,
        seed,
        diagnostics: 'Member browser setup unavailable password=hidden\n',
      }),
      routeDefect: async () => 'dispatched' as const,
    };
    expect(await runPageDataCycle(options)).toBe('ran');
    const retained = readLatestPageDataRun(h.db);
    expect(retained).toMatchObject({ seed, coverage: { status: 'incomplete' }, classes: { API: 1 } });
    const reports = flowReport(readFlow(h.db), []).pageDataRuns;
    expect(reports[0]).toMatchObject({
      seed,
      coverage: { status: 'incomplete' },
      sections: { API: [{ class: 'API' }] },
    });
    expect(reports[1]?.failure?.phase).toBe('check');
    expect(formatPageDataFlowRuns(reports)[0]).toContain('coverage=incomplete; seed=publication-incomplete');
    const log = readFileSync(notices[0]!.summary.match(/output log: (.+)$/)![1]!, 'utf8');
    expect(log).toContain(rows);
    expect(log).toContain('Member browser setup unavailable');
    expect(log).not.toContain('hidden');

    const partial = completed('current', rows, true);
    expect(parsePageDataCompletion(partial, h.registry, 'current', 1).incomplete).toBe(true);
    expect(
      parsePageDataCompletion(completed('current', 'home anonymous feed UNAVAILABLE\n', true), h.registry, 'current', 2)
        .incomplete,
    ).toBe(true);
    for (const [output, code] of [
      [rows, 1],
      [partial, 2],
      [partial.replace('current', 'stale'), 1],
      [partial.replace('current', 'x'.repeat(513)), 1],
      [partial + partial, 1],
      [partial + 'later output\n', 1],
      [partial.replace('"sections":1', '"sections":0'), 1],
      [partial.replace('"defects":1', '"defects":0'), 1],
      [partial.replace('"incomplete":true', '"incomplete":"true"'), 1],
      [partial.replace('home anonymous feed API\n', ''), 1],
      ['Page-data completed {bad}\n', 2],
    ] as const) {
      expect(() => parsePageDataCompletion(output, h.registry, 'current', code)).toThrow();
    }
    options.now = () => new Date('2026-01-01T00:00:00.001Z');
    options.runStack = async () => ({
      output: rows,
      exitCode: 2,
      registry: h.registry,
      seed,
      diagnostics: 'error: child crashed',
    });
    expect(await runPageDataCycle(options)).toBe('failed');
    expect(readLatestPageDataRun(h.db)).toEqual(retained);
    expect(notices.at(-1)?.summary).toContain('error: child crashed');
  } finally {
    h.db.close();
  }
});

test('an owned page-data scope preserves emitted sections when MemoryMax is exhausted', async () => {
  const h = fixture();
  try {
    const invocation = 'scope-test-123';
    const second = { ...h.source, section: 'details', name: 'Details' };
    const scopeRegistry = new Map(h.registry).set(`${second.page}\t${second.persona}\t${second.section}`, second);
    expect(pageDataCheckScopeUnit(invocation)).toBe(`rezics-page-data-${invocation}.scope`);
    const scopeArgs = pageDataCheckScopeArguments(invocation, 'bun', ['scripts/page-data-check.ts']);
    expect(scopeArgs.slice(0, 8)).toEqual([
      '--user',
      '--scope',
      '--collect',
      '--quiet',
      `--slice=${CHECK_SLICE}`,
      `--property=MemoryMax=${WORKER_SCOPE_MEMORY_MAX}`,
      '--property=OOMPolicy=continue',
      `--unit=rezics-page-data-${invocation}.scope`,
    ]);
    expect(scopeArgs.slice(8, 10)).toEqual(['/bin/sh', '-c']);
    expect(scopeArgs[10]).toContain('/sys/fs/cgroup$cgroup/memory.events');
    expect(scopeArgs[10]).toContain('REZICS_PAGE_DATA_SCOPE_OOM_KILLS=');
    expect(scopeArgs.slice(11)).toEqual(['page-data-check-scope', 'bun', 'scripts/page-data-check.ts']);

    const notices: { summary: string }[] = [];
    const output = 'home anonymous feed DATA\nhome anonymous details';
    const limit = `Page-data systemd scope exhausted MemoryMax=${WORKER_SCOPE_MEMORY_MAX}; coverage is incomplete`;
    expect(
      await runPageDataCycle({
        settings: h.settings,
        db: h.db,
        tasks: { tasks: () => [] },
        inbox: { deliver: (notice: { summary: string }) => notices.push(notice) },
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        runStack: async () => ({
          output,
          exitCode: -1,
          registry: scopeRegistry,
          diagnostics: limit,
          scopeLimitExceeded: true,
        }),
        routeDefect: async () => 'dispatched',
      }),
    ).toBe('ran');

    expect(readLatestPageDataRun(h.db)).toMatchObject({
      coverage: { status: 'incomplete' },
      sections: [{ page: 'home', persona: 'anonymous', section: 'feed', class: 'DATA' }],
    });
    expect(notices[0]?.summary).toContain('Incomplete page-data coverage');
    expect(notices[0]?.summary).toContain('MemoryMax=12G');
    const logPath = notices[0]?.summary.match(/output log: (.+)$/)?.[1];
    const log = readFileSync(logPath!, 'utf8');
    expect(log).toContain(output);
    expect(log).toContain(limit);
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
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync, type ChildProcess } from 'node:child_process';
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

test('readiness captures config without inventing listen and preserves its cause before teardown errors', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const captured: PageDataCapture = {
    value: '',
    context: {
      source: 'retained-source',
      run: 'retained-run',
      command: ['bun', 'dev-stack.ts', 'start'],
    },
  };
  let now = 0;
  let emitted = false;
  let failure: unknown;
  try {
    await waitForStack(child as unknown as ChildProcess, ['http://web/en'], 1000, 16384, 1, captured, {
      now: () => now,
      tree: () => [{ pid: 1234, start: '100', parent: 12, executable: '/actual/bun' }],
      probe: async () => {
        if (!emitted) {
          child.stdout.write('Vite localization config current attempt 0\n');
          child.stderr.write('Error:');
          child.stderr.write(' config producer stalled\n');
          emitted = true;
        }
        throw new Error('ECONNREFUSED');
      },
      pause: async (ms) => {
        now += ms;
      },
      signal: (_child, signal) => {
        child.stderr.write('Error: A command must emit at least one event after teardown\n');
        child.signalCode = signal;
        child.emit('close', null, signal);
      },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(PageDataStackError);
  const result = failure as PageDataStackError;
  expect(result.firstErrorLine).toBe('Error: config producer stalled');
  expect(result.output).toContain('after teardown');
  expect(result.output).toContain('retained-source');
  expect(result.output).toContain('retained-run');
  expect(result.output).toContain('/actual/bun');
  expect(result.output).toContain('readiness-deadline');
  expect(result.output).toContain('ECONNREFUSED');
  expect(captured.events?.some((event) => event.kind === 'ready')).toBe(false);
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(16384);
});

test('page-data reconciliation requires the retained dedicated stack and never creates replacement state', async () => {
  const h = harness();
  try {
    const config = join(h.settings.stateDirectory, 'page-data-stack.json');
    await expect(reconcileDedicatedPageDataDefinitions(h.settings)).rejects.toThrow('has not been created');
    expect(() => readFileSync(config)).toThrow();
    writeFileSync(config, 'retained-stack-config');
    await expect(reconcileDedicatedPageDataDefinitions(h.settings)).rejects.toThrow('worktree is missing');
    expect(readFileSync(config, 'utf8')).toBe('retained-stack-config');
  } finally {
    h.dispose();
  }
});

test('page-data member authority provenance survives completion without hiding real forbidden defects', () => {
  const h = fixture();
  const evidence: PageDataUnrunEvidence = {
    version: 1,
    reason: 'member-authority-unavailable',
    scopes: ['follow:list'],
    probes: { native: 'unrun' },
  };
  const source = { ...h.registry.values().next().value!, persona: 'member' };
  const registry = new Map([[`${source.page}\tmember\t${source.section}`, source]]);
  const prefix = `${source.page} member ${source.section}`;
  const row = `${prefix} UNAVAILABLE unrun=${encodeURIComponent(JSON.stringify(evidence))}\n`;
  expect(parsePageDataCompletion(completed('member', row, true), registry, 'member', 2).sections[0]?.unrun).toEqual(
    evidence,
  );
  const problem = { code: 'forbidden' };
  const denied = `${prefix} API nativeProblem=${encodeURIComponent(JSON.stringify(problem))}\n`;
  expect(parsePageDataCompletion(completed('denied', denied), registry, 'denied', 1).sections[0]).toMatchObject({
    class: 'API',
    nativeProblem: problem,
  });
  for (const change of [{ scopes: ['access:grant'] }, { probes: { native: 'run' } }]) {
    const invalid = `${prefix} UNAVAILABLE unrun=${encodeURIComponent(JSON.stringify({ ...evidence, ...change }))}\n`;
    expect(() => parsePageDataOutput(invalid, registry)).toThrow('invalid page-data unrun provenance');
  }
});

test('one run routes and reconciles its related fixture defects as a single producer repair', async () => {
  const h = fixture();
  const start = new Date('2026-01-01T00:00:00.000Z');
  let now = start;
  let outcome: 'EMPTY' | 'SEED' = 'EMPTY';
  let refused = true;
  let checkRuns = 0;
  const routed: PageDataRepair[] = [];
  const registry = new Map<string, SectionConfig>(
    ['tags', 'synopsis'].map((section) => [
      `vn\tmember\t${section}`,
      { page: 'vn', persona: 'member', section, name: section, goal: 'web', files: ['apps/web/src/routes/index.tsx'] },
    ]),
  );
  const options = {
    settings: h.settings,
    db: h.db,
    tasks: { tasks: () => [] },
    inbox: { deliver() {} },
    now: () => now,
    runStack: async (_head: string, invocation: string) => {
      checkRuns++;
      return {
        output: completed(invocation, `vn member tags ${outcome}\nvn member synopsis ${outcome}\n`),
        exitCode: outcome === 'SEED' ? 1 : 0,
        registry,
      };
    },
    routeDefect: async (repair: PageDataRepair) => {
      routed.push(repair);
      return refused
        ? { status: 'refused' as const, reason: 'declared paths touch undeclared risk area: authorization' }
        : ('dispatched' as const);
    },
  };
  try {
    expect(await runPageDataCycle(options)).toBe('ran');
    now = new Date(start.getTime() + 2);
    outcome = 'SEED';
    expect(await runPageDataCycle(options)).toBe('ran');
    expect(routed).toHaveLength(1);
    expect(routed[0]?.section.section).toBe('tags');
    expect(routed[0]?.additional?.map(({ section }) => section.section)).toEqual(['synopsis']);
    const run = readLatestPageDataRun(h.db)!;
    expect(run.sections).toHaveLength(2);
    refused = false;
    expect(await reconcilePageDataRepairs(options, run.runId)).toEqual({ routed: 2, unresolved: [] });
    expect(routed).toHaveLength(2);
    expect(routed[1]?.repairKey).toBe(routed[0]?.repairKey);
    expect(routed[1]?.additional).toEqual(routed[0]?.additional);
    expect(await reconcilePageDataRepairs(options, run.runId)).toEqual({ routed: 0, unresolved: [] });
    expect(checkRuns).toBe(2);
    expect(readLatestPageDataRun(h.db)).toEqual(run);
  } finally {
    h.db.close();
  }
});

test('native relation and link failures route together to Semantic while distinct probes retain their own cause', async () => {
  const h = harness();
  try {
    expect(spawnSync('git', ['branch', 'dev', 'main'], { cwd: h.settings.mainCheckout }).status).toBe(0);
    const start = new Date('2026-01-01T00:00:00.000Z');
    const interval = h.settings.policy?.pageData?.intervalMs ?? 7_200_000;
    let now = start;
    let failing = false;
    const observations = [
      ['related-edition-of', '/v1/subjects/{subject}/relations', { code: 'deadline_exceeded' }],
      ['related-alternative', '/v1/subjects/{subject}/links', { code: 'deadline_exceeded' }],
      ['related-characters', '/v1/subjects/{subject}/relations', { code: 'invalid', pointer: '/property' }],
      ['tags', '/v1/pages:read', { code: 'deadline_exceeded' }],
    ] as const;
    const registry = new Map<string, SectionConfig>(
      observations.map(([section, nativePath]) => [
        `vn\tanonymous\t${section}`,
        {
          page: 'vn',
          persona: 'anonymous',
          section,
          name: section,
          goal: 'web',
          nativePath,
          files: ['apps/web/src/routes/index.tsx'],
        },
      ]),
    );
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    const job = { resumePageDataRepair: async () => false };
    const options = {
      settings: h.settings,
      db: h.store.db,
      tasks: h.store,
      inbox,
      now: () => now,
      runStack: async (_head: string, invocation: string) => ({
        output: completed(
          invocation,
          observations
            .map(
              ([section, _path, problem]) =>
                `vn anonymous ${section} ${failing ? `API nativeProblem=${encodeURIComponent(JSON.stringify(problem))}` : 'DATA'}\n`,
            )
            .join(''),
        ),
        exitCode: failing ? 1 : 0,
        registry,
      }),
      routeDefect: (repair: PageDataRepair) => routePageDataRepair(h.tasks, h.store, job, inbox, h.settings, repair),
    };
    expect(await runPageDataCycle(options)).toBe('ran');
    now = new Date(start.getTime() + interval);
    failing = true;
    expect(await runPageDataCycle(options)).toBe('ran');
    const repairs = h.store.tasks().map(({ id }) => h.store.task(id));
    expect(repairs.map(({ brief }) => brief.goal).sort()).toEqual(['semantic', 'semantic', 'web']);
    const grouped = repairs.find(({ brief }) => brief.markdown.includes('related-edition-of'))!;
    expect(grouped.brief.markdown).toContain('related-alternative');
    expect(grouped.brief.paths).toContain('services/kernel/src/semantic/http/subjects.ts');
    expect(grouped.brief.paths.includes('apps/web/src/routes/index.tsx')).toBe(false);
    expect(readLatestPageDataRun(h.store.db)?.sections).toHaveLength(4);
    now = new Date(now.getTime() + interval);
    expect(await runPageDataCycle(options)).toBe('ran');
    expect(h.store.tasks()).toHaveLength(3);
  } finally {
    await h.disposeAsync();
  }
});
