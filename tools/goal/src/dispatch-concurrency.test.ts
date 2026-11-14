import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, markdown } from './test-support.ts';

test('direct dispatch and a claimed backlog submission share one active registration', async () => {
  const h = harness();
  const childFile = join(h.settings.stateDirectory, 'dispatch-child.ts');
  writeFileSync(
    childFile,
    `
    import {join} from 'node:path'; import {loadSettings} from ${JSON.stringify(join(import.meta.dir, 'config.ts'))};
    import {openDb} from ${JSON.stringify(join(import.meta.dir, 'db.ts'))}; import {WorkerStore} from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
    import {WorkerTasks} from ${JSON.stringify(join(import.meta.dir, 'tasks.ts'))};
    const settings=loadSettings({cwd:process.env.FIXTURE_ROOT!,env:{}}), store=new WorkerStore(openDb(join(settings.stateDirectory,'goal.sqlite')));
    try {
      const task=new WorkerTasks(settings,store).dispatch(process.env.FIXTURE_BRIEF!,undefined,false,undefined,
        process.env.FIXTURE_BACKLOG==='true'?{goal:'fixture',markdown:process.env.FIXTURE_MARKDOWN!}:undefined);
      console.log(JSON.stringify({id:task.id,worktree:task.worktree}));
    } finally {store.db.close();}
  `,
  );
  const directBrief = join(h.settings.stateDirectory, 'direct.md');
  const claimDirectory = join(h.settings.stateDirectory, 'backlog', 'fixture', '.dispatching');
  const claimedBrief = join(claimDirectory, 'same.md');
  mkdirSync(claimDirectory, { recursive: true });
  writeFileSync(directBrief, markdown);
  writeFileSync(claimedBrief, markdown);
  const env = { ...process.env, FIXTURE_ROOT: h.root, FIXTURE_MARKDOWN: markdown };
  const start = (brief: string, backlog: boolean) =>
    Bun.spawn([process.execPath, childFile], {
      env: { ...env, FIXTURE_BRIEF: brief, FIXTURE_BACKLOG: String(backlog) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const direct = start(directBrief, false);
  const harvested = start(claimedBrief, true);
  try {
    const [codes, outputs] = await Promise.all([
      Promise.all([direct.exited, harvested.exited]),
      Promise.all([new Response(direct.stdout).text(), new Response(harvested.stdout).text()]),
    ]);
    expect(codes).toEqual([0, 0]);
    const [directResult, harvestedResult] = outputs.map((output) => JSON.parse(output.trim()));
    expect(harvestedResult.id).toBe(directResult.id);
    expect(harvestedResult.worktree).toBe(directResult.worktree);
    const tasks = h.store.tasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(directResult.id);
    expect(tasks[0]?.worktree).toBe(directResult.worktree);
    expect(tasks[0]?.currentAttempt).toBe(0);
    expect(existsSync(tasks[0]!.worktree)).toBe(true);
  } finally {
    direct.kill();
    harvested.kill();
    h.dispose();
  }
});

test('concurrent dispatch processes wait for the lifecycle lease', async () => {
  const h = harness();
  const childFile = join(h.settings.stateDirectory, 'dispatch-child.ts');
  writeFileSync(
    childFile,
    `
    import { join } from 'node:path';
    import { loadSettings } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))};
    import { openDb } from ${JSON.stringify(join(import.meta.dir, 'db.ts'))};
    import { WorkerStore } from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
    import { WorkerTasks } from ${JSON.stringify(join(import.meta.dir, 'tasks.ts'))};
    const settings = loadSettings({ cwd: process.env.FIXTURE_ROOT!, env: {} });
    const store = new WorkerStore(openDb(join(settings.stateDirectory, 'goal.sqlite')));
    try { console.log(new WorkerTasks(settings, store).dispatch(process.env.FIXTURE_BRIEF!).id); }
    finally { store.db.close(); }
  `,
  );
  const firstBrief = join(h.settings.stateDirectory, 'first.md');
  const secondBrief = join(h.settings.stateDirectory, 'second.md');
  writeFileSync(firstBrief, markdown);
  writeFileSync(secondBrief, markdown.replace('goal: fixture', 'goal: second fixture'));
  const env = { ...process.env, FIXTURE_ROOT: h.root };
  const start = (brief: string) =>
    Bun.spawn([process.execPath, childFile], {
      env: { ...env, FIXTURE_BRIEF: brief },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const first = start(firstBrief);
  const second = start(secondBrief);
  try {
    const [firstCode, secondCode] = await Promise.all([first.exited, second.exited]);
    expect(firstCode).toBe(0);
    expect(secondCode).toBe(0);
    expect(h.store.tasks()).toHaveLength(2);
  } finally {
    first.kill();
    second.kill();
    h.dispose();
  }
});
