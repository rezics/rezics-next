import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, markdown } from './test-support.ts';

test('concurrent dispatch processes wait for the lifecycle lease', async () => {
  const h = harness();
  const childFile = join(h.settings.stateDirectory, 'dispatch-child.ts');
  writeFileSync(childFile, `
    import { join } from 'node:path';
    import { loadSettings } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))};
    import { openDb } from ${JSON.stringify(join(import.meta.dir, 'db.ts'))};
    import { WorkerStore } from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
    import { WorkerTasks } from ${JSON.stringify(join(import.meta.dir, 'tasks.ts'))};
    const settings = loadSettings({ cwd: process.env.FIXTURE_ROOT!, env: {} });
    const store = new WorkerStore(openDb(join(settings.stateDirectory, 'goal.sqlite')));
    try { console.log(new WorkerTasks(settings, store).dispatch(process.env.FIXTURE_BRIEF!).id); }
    finally { store.db.close(); }
  `);
  const firstBrief = join(h.settings.stateDirectory, 'first.md');
  const secondBrief = join(h.settings.stateDirectory, 'second.md');
  writeFileSync(firstBrief, markdown);
  writeFileSync(secondBrief, markdown.replace('goal: fixture', 'goal: second fixture'));
  const env = { ...process.env, FIXTURE_ROOT: h.root };
  const start = (brief: string) => Bun.spawn([process.execPath, childFile], {
    env: { ...env, FIXTURE_BRIEF: brief }, stdout: 'pipe', stderr: 'pipe',
  });
  const first = start(firstBrief);
  const second = start(secondBrief);
  try {
    const [firstCode, secondCode] = await Promise.all([first.exited, second.exited]);
    expect(firstCode).toBe(0);
    expect(secondCode).toBe(0);
    expect(h.store.tasks()).toHaveLength(2);
  } finally { first.kill(); second.kill(); h.dispose(); }
});
