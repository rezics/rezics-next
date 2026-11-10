import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyRiskAreas, readRiskOwnership, riskAreaRulesFor } from './briefs.ts';
import { testFailureRepairBrief, type TestFailureRepair } from './dev-verifier.ts';
import type { SqliteManagerInbox } from './inbox.ts';
import type { WorkerJob } from './job.ts';
import { isPageDataRiskRefusal, type PageDataRepair, type PageDataRepairRoute } from './page-data.ts';
import type { WorkerStore } from './store.ts';
import type { WorkerTasks } from './tasks.ts';
import type { Settings } from './types.ts';

type RoutingSettings = Pick<Settings, 'stateDirectory' | 'riskAreasFile'> & {
  policy?: Pick<NonNullable<Settings['policy']>, 'verifier' | 'brief'>;
};

export type RuntimeRepairRoutingDependencies = {
  tasks: Pick<WorkerTasks, 'dispatch'>;
  store: Pick<WorkerStore, 'task' | 'tasks' | 'updateTask'>;
  job: Pick<WorkerJob, 'resumePageDataRepair'>;
  inbox: Pick<SqliteManagerInbox, 'deliver'>;
  settings: RoutingSettings;
};

function dispatchOwnedRepair(
  { tasks, store, inbox, settings }: RuntimeRepairRoutingDependencies,
  repair: TestFailureRepair,
  markdown: string,
  directory: string,
  created: string,
  updated: string,
): void {
  if (repair.existingTaskId) {
    const task = store.task(repair.existingTaskId);
    writeFileSync(task.briefPath, markdown);
    store.updateTask({ taskId: task.id, attempt: task.currentAttempt }, (item) => {
      item.brief = { ...item.brief, markdown, urgent: true };
    });
    inbox.deliver({
      managerId: repair.owner.brief.manager,
      taskId: task.id,
      kind: 'instruction',
      summary: updated,
    });
    return;
  }
  const briefPath = join(settings.stateDirectory, directory, `${randomUUID()}.md`);
  mkdirSync(dirname(briefPath), { recursive: true });
  writeFileSync(briefPath, markdown);
  const task = tasks.dispatch(briefPath, null, true, 'verifier');
  inbox.deliver({
    managerId: repair.owner.brief.manager,
    taskId: task.id,
    kind: 'instruction',
    summary: created,
  });
}

function dispatchTestFailureRepair(dependencies: RuntimeRepairRoutingDependencies, repair: TestFailureRepair): void {
  if (repair.failures.length && repair.failures.every(({ cause }) => cause === 'compiler')) {
    const byOwner = new Map<string, typeof repair.failures>();
    for (const failure of repair.failures) {
      byOwner.set(failure.owner.id, [...(byOwner.get(failure.owner.id) ?? []), failure]);
    }
    for (const failures of byOwner.values()) {
      const owner = failures[0]!.owner;
      dependencies.inbox.deliver({
        managerId: owner.brief.manager,
        taskId: owner.id,
        kind: 'instruction',
        summary: failures
          .map((failure) => {
            const location = failure.diagnostic?.location;
            const command = failure.command;
            const message = failure.diagnostic?.message ?? failure.assertions.join('\n');
            const raw = failure.error.slice(-600);
            return [
              `Verifier compiler diagnostic ${failure.diagnostic?.code ?? ''} ${location ? `${location.file}:${location.line ?? '?'}:${location.column ?? '?'}` : ''}: ${message}`.trim(),
              `Captured revision ${failure.sourceRevision ?? repair.commit}; command ${JSON.stringify(command?.argv ?? [])}; cwd ${command?.cwd ?? '.'}; result ${failure.evidenceLogPath ?? 'unavailable'}.`,
              `Original compiler output: ${raw}`,
            ].join(' ');
          })
          .join('\n'),
      });
    }
    return;
  }

  const tests = repair.failures.flatMap((failure) => (failure.test ? [failure.test] : []));
  dispatchOwnedRepair(
    dependencies,
    repair,
    testFailureRepairBrief(repair, dependencies.settings.policy?.verifier),
    'test-failure-repairs',
    `Urgent repair for ${tests.length} failing tests at ${repair.commit}: ${tests.join(', ')}.`,
    `These tests still fail at ${repair.commit}: ${tests.join(', ')}.`,
  );
}

function pageDataRepairBrief(repair: PageDataRepair, goal: string, manager: string, riskAreas: string[]): string {
  return `---\n${JSON.stringify(
    {
      goal,
      manager,
      kind: 'implementation',
      paths: repair.section.files,
      riskAreas,
      urgent: true,
      acceptance: { failing: true },
      estimate: { lines: 700, files: 12 },
      criticalPath: false,
      waiting: [],
      after: [],
    },
    null,
    2,
  )}\n---\n\n# Repair a seeded page-data defect\n\npage-data-repair-key: ${repair.repairKey}\n\nRepair section \`${repair.section.page}/${repair.section.persona}/${repair.section.section}\` in class \`${repair.section.class}\` (previously \`${repair.previousClass}\`).\n\nIntegrated dev head: \`${repair.head}\`. First error line: \`${repair.section.firstErrorLine ?? 'unavailable'}\`.\n`;
}

export async function routePageDataRepair(
  tasks: RuntimeRepairRoutingDependencies['tasks'],
  store: Pick<WorkerStore, 'tasks'>,
  job: RuntimeRepairRoutingDependencies['job'],
  inbox: RuntimeRepairRoutingDependencies['inbox'],
  settings: RoutingSettings,
  repair: PageDataRepair,
): Promise<PageDataRepairRoute> {
  if (await job.resumePageDataRepair(repair)) return 'resumed';
  const existing = store
    .tasks()
    .find((task) => task.brief.markdown.includes(`page-data-repair-key: ${repair.repairKey}`));
  const goal = repair.owner?.brief.goal ?? repair.section.goal;
  const manager = repair.owner?.brief.manager ?? goal;
  if (existing) {
    inbox.deliver({
      managerId: existing.brief.manager,
      taskId: existing.id,
      kind: 'instruction',
      summary: `Seeded page-data section ${repair.section.page}/${repair.section.section} is ${repair.section.class}; first error line: ${repair.section.firstErrorLine ?? 'unavailable'}.`,
    });
    return 'dispatched';
  }
  const policy = settings.policy?.brief;
  const rules = riskAreaRulesFor(readRiskOwnership(settings.riskAreasFile, policy));
  const riskAreas = [
    ...new Set(repair.section.files.flatMap((path) => classifyRiskAreas(path, rules, 'pattern', policy))),
  ];
  const markdown = pageDataRepairBrief(repair, goal, manager, riskAreas);
  const briefPath = join(settings.stateDirectory, 'page-data-repairs', `${repair.repairKey}.brief.md`);
  mkdirSync(dirname(briefPath), { recursive: true });
  if (existsSync(briefPath)) {
    const previous = readFileSync(briefPath, 'utf8');
    if (previous !== markdown) {
      // The retained refusal authorizes only replacement of the generator's empty risk declaration.
      if (
        !repair.reconcileRiskRefusal ||
        !riskAreas.length ||
        previous !== pageDataRepairBrief(repair, goal, manager, [])
      )
        throw new Error('page-data repair brief changed for an existing cause');
      const staged = `${briefPath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(staged, markdown, { flag: 'wx', mode: 0o600 });
        renameSync(staged, briefPath);
      } finally {
        rmSync(staged, { force: true });
      }
    }
  } else writeFileSync(briefPath, markdown, { flag: 'wx', mode: 0o600 });
  let task: ReturnType<typeof tasks.dispatch>;
  try {
    task = tasks.dispatch(briefPath, null, true, 'verifier');
  } catch (error) {
    if (error instanceof Error && isPageDataRiskRefusal(error.message))
      return { status: 'refused', reason: error.message };
    throw error;
  }
  inbox.deliver({
    managerId: task.brief.manager,
    taskId: task.id,
    kind: 'instruction',
    summary: `Seeded page-data repair for ${repair.section.page}/${repair.section.section}: ${repair.section.class}; first error line: ${repair.section.firstErrorLine ?? 'unavailable'}.`,
  });
  return 'dispatched';
}

export function createRuntimeRepairRouting(dependencies: RuntimeRepairRoutingDependencies) {
  return {
    dispatchTestFailureRepair: (repair: TestFailureRepair) => dispatchTestFailureRepair(dependencies, repair),
    routePageDataRepair: (repair: PageDataRepair) =>
      routePageDataRepair(
        dependencies.tasks,
        dependencies.store,
        dependencies.job,
        dependencies.inbox,
        dependencies.settings,
        repair,
      ),
  };
}
