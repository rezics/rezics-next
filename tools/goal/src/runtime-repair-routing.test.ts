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
      paths: ['apps/web/tests/library.test.ts', 'services/kernel/test/session.test.ts'],
      failures: [
        {
          test: 'apps/web/tests/library.test.ts',
          assertions: ['AssertionError: library filter failed'],
          error: 'AssertionError: library filter failed',
          owner,
          command: { argv: ['env', 'bun', 'test', 'tests/library.test.ts'], cwd: 'apps/web' },
          sourceRevision: 'captured-web-head',
          evidenceLogPath: '.temp/goal/web-library-check.log',
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
    expect(created.brief.markdown).toContain('captured-web-head');
    expect(created.brief.markdown).toContain('.temp/goal/web-library-check.log');
    expect(created.brief.markdown).toContain('"tests/library.test.ts"');
    expect(inbox.read(owner.brief.manager).map(({ event }) => event)).toContainEqual(
      expect.objectContaining({
        managerId: owner.brief.manager,
        taskId: created.id,
        goalId: owner.brief.goal,
        kind: 'instruction',
        summary: expect.stringContaining('apps/web/tests/library.test.ts'),
      }),
    );

    routing.dispatchTestFailureRepair({
      ...repair,
      commit: 'repeated-head',
      existingTaskId: created.id,
      failures: repair.failures.map((failure) => ({
        ...failure,
        assertions: [...failure.assertions, 'Repeated verifier assertion'],
      })),
    });
    expect(dispatches).toHaveLength(1);
    expect(
      h.store
        .tasks()
        .filter((task) => task.brief.markdown.includes('Test failure repair batch for goal'))
        .map((task) => task.id),
    ).toEqual([created.id]);
    expect(h.store.task(created.id).brief.markdown).toContain('Repeated verifier assertion');
  } finally {
    h.dispose();
  }
});

test('compiler diagnostics notify the concrete source owner without dispatching an implementation brief', () => {
  const h = harness();
  const inbox = new SqliteManagerInbox(
    h.store.db,
    h.settings.integration.inboxDirectory,
    undefined,
    h.settings.policy?.inbox,
  );
  const dispatches: unknown[] = [];
  const routing = createRuntimeRepairRouting({
    tasks: {
      dispatch(...args) {
        dispatches.push(args);
        throw new Error('compiler findings must not create an implementation brief');
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
      commit: 'captured-revision',
      owner,
      paths: ['services/auth/scripts/dev-stack.ts'],
      failures: [
        {
          assertions: ["TS2448: Block-scoped variable 'worker' used before its declaration."],
          error: 'captured compiler output: TS2448 worker TDZ',
          owner,
          cause: 'compiler',
          diagnostic: {
            cause: 'compiler',
            code: 'TS2448',
            message: "Block-scoped variable 'worker' used before its declaration.",
            location: {
              file: 'services/auth/scripts/dev-stack.ts',
              line: 1108,
              column: 92,
              workspace: 'apps/web',
              resolved: true,
            },
          },
          command: {
            argv: ['env', 'TYPECHECK_CHANGED=services/auth/scripts/dev-stack.ts', 'bun', 'scripts/typecheck.ts'],
          },
          sourceRevision: 'captured-revision',
          evidenceLogPath: '.temp/goal/dev-verify-original.log',
        },
      ],
    };
    routing.dispatchTestFailureRepair(repair);

    expect(dispatches).toHaveLength(0);
    expect(inbox.read(owner.brief.manager).map(({ event }) => event)).toContainEqual(
      expect.objectContaining({
        managerId: owner.brief.manager,
        taskId: owner.id,
        kind: 'instruction',
        summary: expect.stringContaining('services/auth/scripts/dev-stack.ts:1108:92'),
      }),
    );
    const message = inbox.read(owner.brief.manager).find(({ event }) => event.taskId === owner.id)!.event.summary;
    expect(message).toContain('captured-revision');
    expect(message).toContain('.temp/goal/dev-verify-original.log');
    expect(message).toContain('TYPECHECK_CHANGED=services/auth/scripts/dev-stack.ts');
    expect(message).toContain('captured compiler output: TS2448 worker TDZ');
  } finally {
    h.dispose();
  }
});

test('seed repair uses the fixture producer and skips a cancelled consumer copy', async () => {
  const h = harness();
  const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
  const repairKey = 'a'.repeat(64);
  try {
    const reader = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: reader.id, attempt: reader.currentAttempt }, (task) => {
      task.state = 'cancelled';
      task.brief = {
        ...task.brief,
        goal: 'web',
        markdown: task.brief.markdown + `\npage-data-repair-key: ${repairKey}\n`,
      };
    });
    const routing = createRuntimeRepairRouting({
      tasks: h.tasks,
      store: h.store,
      job: {
        async resumePageDataRepair() {
          throw new Error('a Web reader cannot own a seed repair');
        },
      },
      inbox,
      settings: h.settings,
    });
    const seed = {
      repairKey,
      head: 'retained-source',
      previousClass: 'EMPTY' as const,
      owner: h.store.task(reader.id),
      section: {
        page: 'vn',
        persona: 'member',
        section: 'tags',
        name: 'Tags',
        class: 'SEED' as const,
        goal: 'web',
        files: ['services/auth/src/authorization/permissions.ts'],
      },
    };
    expect(await routing.routePageDataRepair(seed)).toBe('dispatched');
    expect(await routing.routePageDataRepair(seed)).toBe('dispatched');
    const producers = h.store.tasks().filter((task) => task.brief.goal === 'imports');
    expect(producers).toHaveLength(1);
    const producer = h.store.task(producers[0]!.id);
    expect(producer.brief.paths).toContain('scripts/datasets/cross-media-seed.ts');
    expect(producer.brief.paths).toContain('services/importer/src/showcase-*.ts');
    expect(producer.brief.paths.includes(seed.section.files[0]!)).toBe(false);
    expect(producer.brief.riskAreas).toEqual([]);
    expect(producer.brief.markdown).toContain('vn/member/tags');
    expect(h.store.task(reader.id).state).toBe('cancelled');
  } finally {
    await h.disposeAsync();
  }
});
