import { expect, test } from 'bun:test';
import { SqliteManagerInbox } from './inbox.ts';
import { createRuntimeRepairRouting } from './runtime-repair-routing.ts';
import type { TestFailureRepair } from './dev-verifier.ts';
import { harness } from './test-support.ts';

test('runtime repair callback dispatches one urgent task with all failing files and assertions', () => {
  const h = harness();
  const inbox = new SqliteManagerInbox(
    h.store.db,
    h.settings.integration.inboxDirectory,
    undefined,
    h.settings.policy?.inbox,
  );
  const dispatches: { args: Parameters<typeof h.tasks.dispatch>; id: string }[] = [];
  const routing = createRuntimeRepairRouting({
    tasks: {
      dispatch(...args) {
        const task = h.tasks.dispatch(...args);
        dispatches.push({ args, id: task.id });
        return task;
      },
    },
    store: h.store,
    job: { resumePageDataRepair: async () => false },
    inbox,
    settings: h.settings,
  });

  try {
    const owner = h.tasks.dispatch(h.briefFile);
    const repair: TestFailureRepair = {
      goal: owner.brief.goal,
      manager: owner.brief.manager,
      commit: 'broken-head',
      owner,
      paths: ['apps/web/**', 'services/kernel/**'],
      failures: [
        {
          test: 'apps/web/tests/library.test.ts',
          assertions: ['AssertionError: library filter failed'],
          error: 'AssertionError: library filter failed',
          owner,
        },
        {
          test: 'services/kernel/test/session.test.ts',
          assertions: ['AssertionError: session state mismatch'],
          error: 'AssertionError: session state mismatch',
          owner,
        },
      ],
    };
    routing.dispatchTestFailureRepair(repair);

    const [call] = dispatches;
    const created = h.store.task(call!.id);
    expect(dispatches).toHaveLength(1);
    expect(call!.args.slice(1)).toEqual([null, true, 'verifier']);
    expect(created.brief).toMatchObject({ goal: owner.brief.goal, manager: owner.brief.manager, urgent: true });
    expect(created.brief.markdown).toContain('Test failure repair batch for goal');
    expect(created.brief.markdown).toContain('apps/web/tests/library.test.ts');
    expect(created.brief.markdown).toContain('services/kernel/test/session.test.ts');
    expect(created.brief.markdown).toContain('AssertionError: library filter failed');
    expect(created.brief.markdown).toContain('AssertionError: session state mismatch');
    expect(inbox.read(owner.brief.manager).map(({ event }) => event)).toContainEqual(
      expect.objectContaining({
        managerId: owner.brief.manager,
        taskId: created.id,
        goalId: owner.brief.goal,
        kind: 'instruction',
        summary: expect.stringContaining('apps/web/tests/library.test.ts'),
      }),
    );
  } finally {
    h.dispose();
  }
});
