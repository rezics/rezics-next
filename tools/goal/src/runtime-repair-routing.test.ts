import { expect, test } from 'bun:test';
import { SqliteManagerInbox } from './inbox.ts';
import { createRuntimeRepairRouting } from './runtime-repair-routing.ts';
import type { BootSmokeRepair, TestFailureRepair } from './dev-verifier.ts';
import { harness } from './test-support.ts';

test('runtime repair callbacks update the existing boot task or dispatch one urgent task to its owner', () => {
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
    const existing = h.tasks.dispatch(h.briefFile);
    const repair: BootSmokeRepair = {
      test: 'services/kernel/test/boot/kernel-boots.test.ts',
      commit: 'broken-head',
      error: 'Error: kernel did not boot',
      owner,
    };
    const existingAttempt = h.store.task(existing.id).currentAttempt;

    routing.dispatchBootSmokeRepair({ ...repair, existingTaskId: existing.id });

    const updated = h.store.task(existing.id);
    expect(updated).toMatchObject({ id: existing.id, currentAttempt: existingAttempt });
    expect(updated.brief).toMatchObject({
      goal: owner.brief.goal,
      manager: owner.brief.manager,
      urgent: true,
    });
    expect(updated.brief.markdown).toContain('Commit `broken-head` broke the repository boot smoke.');
    expect(dispatches).toHaveLength(0);
    expect(inbox.read(owner.brief.manager).map(({ event }) => event)).toContainEqual({
      managerId: owner.brief.manager,
      taskId: existing.id,
      goalId: owner.brief.goal,
      kind: 'instruction',
      summary: 'Boot smoke still fails on services/kernel/test/boot/kernel-boots.test.ts at broken-head.',
    });

    routing.dispatchBootSmokeRepair(repair);

    const testRepair: TestFailureRepair = {
      test: 'apps/web/tests/library.test.ts',
      commit: 'broken-head',
      error: 'AssertionError: library filter failed',
      owner,
    };
    routing.dispatchTestFailureRepair(testRepair);
    const createdTest = h.store.task(dispatches.at(-1)!.id);
    expect(createdTest.brief.markdown).toContain('Test failure repair for `apps/web/tests/library.test.ts`');
    expect(createdTest.brief.urgent).toBe(true);

    const [call] = dispatches;
    const created = h.store.task(call!.id);
    expect(call!.args.slice(1)).toEqual([null, true, 'verifier']);
    expect(created.brief).toMatchObject({
      goal: owner.brief.goal,
      manager: owner.brief.manager,
      urgent: true,
    });
    expect(created.brief.markdown).toContain('Error: kernel did not boot');
    expect(inbox.read(owner.brief.manager).map(({ event }) => event)).toContainEqual({
      managerId: owner.brief.manager,
      taskId: created.id,
      goalId: owner.brief.goal,
      kind: 'instruction',
      summary: 'Urgent boot-smoke repair for services/kernel/test/boot/kernel-boots.test.ts at broken-head.',
    });
  } finally {
    h.dispose();
  }
});
