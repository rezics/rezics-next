import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choosePoolWithFallback } from './allowance.ts';
import { claudeAdapter } from './agents/claude.ts';
import { codexAdapter } from './agents/codex.ts';
import { sweepBacklog, type BacklogRuntime } from './backlog.ts';
import { openDb } from './db.ts';
import type { ManagerEvent } from './contracts.ts';
import { parseBrief } from './briefs.ts';
import { routeTask, type RoutingTable } from './routing.ts';
import { WorkerStore } from './store.ts';
import { fixturePool, reading, temporaryDirectory } from './test-support.ts';
import type { Pool, Profile } from './types.ts';

const NOW = Date.UTC(2026, 10, 5, 12, 0);
const pendingCleanup: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of pendingCleanup.splice(0)) cleanup();
});

type RuntimeFixture = {
  db: Database;
  state: string;
  runtime: BacklogRuntime;
  events: ManagerEvent[];
  dispatched: { file: string; text: string }[];
};

function fixture(): RuntimeFixture {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'goal.sqlite'));
  new WorkerStore(db);
  const events: ManagerEvent[] = [];
  const dispatched: { file: string; text: string }[] = [];
  let sequence = 0;
  const runtime: BacklogRuntime = {
    db,
    stateDirectory: temporary.path,
    inbox: { deliver: (event) => events.push(event) },
    now: () => NOW,
    workerCap: 32,
    async dispatch(file) {
      const text = readFileSync(file, 'utf8');
      const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
      if (!header) throw new Error('test brief has no front matter');
      const brief = Bun.YAML.parse(header) as Record<string, unknown>;
      const id = `research-${++sequence}`;
      db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, 1, ?)').run(
        id,
        sequence,
        JSON.stringify({ id, state: 'ready', createdAt: new Date(NOW).toISOString(), brief }),
      );
      dispatched.push({ file, text });
      return id;
    },
    async continueTask() {},
    async cancel() {},
  };
  pendingCleanup.push(() => {
    db.close();
    temporary.close();
  });
  return { db, state: temporary.path, runtime, events, dispatched };
}

function researchMarkdown(researchers = 'researchers: [gpt-6-astra, claude-opus-5-5]'): string {
  return `---
goal: research
manager: research-owner
kind: research
paths: [docs/research/access-model.md]
${researchers}
riskAreas: []
acceptance:
  command: [bun, test, docs/research/access-model.md]
  tests: [the report exists]
  failing: true
estimate: { lines: 20, files: 1 }
criticalPath: false
waiting: []
---
Compare access models in mature products and recommend one for this repository.
`;
}

function readyBrief(state: string, markdown: string): void {
  const directory = join(state, 'backlog', 'research');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'access-model.md');
  writeFileSync(file, markdown);
  const at = (NOW - 60_000) / 1000;
  utimesSync(file, at, at);
}

const codexRoute = { cli: 'codex', model: 'gpt-6-astra', effort: 'xhigh', poolClass: 'codex' } as Profile;
const routing = {
  version: 'test',
  classes: {
    research: { first: codexRoute, maxSteps: 5, maxMs: 1000 },
    implementation: { first: codexRoute, maxSteps: 5, maxMs: 1000 },
  },
  experiments: [],
  consultation: codexRoute,
} as unknown as RoutingTable;

test('research fan-out pins separate model tasks and delivers one completion event after every task ends', async () => {
  const f = fixture();
  readyBrief(f.state, researchMarkdown());
  const dispatched = await sweepBacklog(f.runtime);
  expect(dispatched.dispatched).toHaveLength(2);
  const parsed = f.dispatched.map(({ text }) => parseBrief(text, { version: 1, areas: {} }));
  const routes = parsed.map((brief, index) => routeTask(brief, index + 1, routing).profile);
  expect(routes.map(({ cli, model }) => [cli, model])).toEqual([
    ['codex', 'gpt-6-astra'],
    ['claude', 'claude-opus-5-5'],
  ]);
  expect(parsed.map((brief) => brief.researchReport)).toEqual([
    'docs/research/access-model-gpt-6-astra.md',
    'docs/research/access-model-claude-opus-5-5.md',
  ]);
  expect(parsed.map((brief) => brief.acceptance.command.at(-1))).toEqual([
    'docs/research/access-model-gpt-6-astra.md',
    'docs/research/access-model-claude-opus-5-5.md',
  ]);
  expect(f.dispatched.every(({ text }) => text.includes('Do not wait for or read another researcher'))).toBe(true);

  for (const [index, row] of (
    f.db.query('SELECT id, body FROM worker_tasks ORDER BY sequence').all() as {
      id: string;
      body: string;
    }[]
  ).entries()) {
    const body = JSON.parse(row.body) as Record<string, unknown>;
    f.db
      .query('UPDATE worker_tasks SET body=? WHERE id=?')
      .run(JSON.stringify({ ...body, state: index === 0 ? 'integrated' : 'stopped' }), row.id);
  }
  await sweepBacklog(f.runtime);
  await sweepBacklog(f.runtime);
  const completions = f.events.filter((event) => event.kind === 'research-complete');
  expect(completions).toHaveLength(1);
  expect(completions[0]).toMatchObject({ managerId: 'research-owner', goalId: 'research' });
  expect(completions[0]!.summary).toContain('docs/research/access-model-gpt-6-astra.md');
  expect(completions[0]!.summary).toContain('docs/research/access-model-claude-opus-5-5.md');
  expect(completions[0]!.summary).toContain('failed researchers: claude-opus-5-5');
});

test('Claude pins use the claude-worker allowance and research web search while non-research pins are refused', () => {
  const claude = routeTask(
    { ...parseBrief(researchMarkdown('model: claude-opus-5-5'), { version: 1, areas: {} }), model: 'claude-opus-5-5' },
    1,
    routing,
  ).profile;
  expect(claude).toMatchObject({ cli: 'claude', model: 'claude-opus-5-5', poolClass: 'claude' });
  expect(() =>
    routeTask(
      {
        ...parseBrief(researchMarkdown('model: claude-opus-5-5').replace('kind: research', 'kind: implementation'), {
          version: 1,
          areas: {},
        }),
        model: 'claude-opus-5-5',
      },
      1,
      routing,
    ),
  ).toThrow('Claude model pins are only supported on research briefs');

  const base = fixturePool('/claude-account');
  const pool: Pool = {
    ...base,
    name: 'claude-worker',
    cli: 'claude',
    classes: ['claude'],
    allowanceKey: 'claude',
    policy: { ...base.policy, reservePercent: 15 },
  };
  const now = Date.now();
  expect(choosePoolWithFallback(claude, [], [pool], [reading(pool, 84)], { now }).pool.name).toBe('claude-worker');
  expect(() => choosePoolWithFallback(claude, [], [pool], [reading(pool, 86)], { now })).toThrow('no allowed pool');

  const claudeCommand = claudeAdapter.start({
    profile: claude,
    pool,
    worktree: '/work',
    prompt: 'research',
    research: true,
  });
  const codexCommand = codexAdapter.start({
    profile: codexRoute,
    pool: { ...pool, name: 'codex', cli: 'codex' },
    worktree: '/work',
    prompt: 'research',
    research: true,
  });
  expect(claudeCommand[1]).toContain('--allowedTools');
  expect(claudeCommand[1]).toContain('WebSearch');
  expect(codexCommand[1]).toContain('web_search="live"');
});

test('a single model: research brief remains one normally pinned task', async () => {
  const f = fixture();
  readyBrief(f.state, researchMarkdown('model: gpt-6-astra'));
  const result = await sweepBacklog(f.runtime);
  expect(result.dispatched).toHaveLength(1);
  expect(f.dispatched).toHaveLength(1);
  expect(parseBrief(f.dispatched[0]!.text, { version: 1, areas: {} }).model).toBe('gpt-6-astra');
  expect(f.db.query('SELECT count(*) AS count FROM research_groups').get()).toEqual({ count: 0 });
});
