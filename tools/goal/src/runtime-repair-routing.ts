import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyRiskAreas, readRiskOwnership, riskAreaRulesFor } from './briefs.ts';
import { testFailureRepairBrief, type TestFailureRepair } from './dev-verifier.ts';
import type { SqliteManagerInbox } from './inbox.ts';
import type { WorkerJob } from './job.ts';
import {
  isPageDataRiskRefusal,
  pageDataRepairTarget,
  pageDataRepairEvidence,
  type PageDataRepair,
  type PageDataRepairRoute,
} from './page-data.ts';
import type { WorkerStore } from './store.ts';
import type { WorkerTasks } from './tasks.ts';
import type { Settings } from './types.ts';

type RoutingSettings = Pick<Settings, 'stateDirectory' | 'riskAreasFile'> & {
  integration: Pick<Settings['integration'], 'supermanager'>;
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

function pageDataRepairBrief(
  repair: PageDataRepair,
  goal: string,
  manager: string,
  riskAreas: string[],
  paths = repair.section.files,
): string {
  const additional = repair.additional?.length ? '\n' + pageDataRepairEvidence(repair) : '';
  return `---\n${JSON.stringify(
    {
      goal,
      manager,
      kind: 'implementation',
      paths,
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
  )}\n---\n\n# Repair a seeded page-data defect\n\npage-data-repair-key: ${repair.repairKey}\n\nRepair section \`${repair.section.page}/${repair.section.persona}/${repair.section.section}\` in class \`${repair.section.class}\` (previously \`${repair.previousClass}\`).\n\nIntegrated dev head: \`${repair.head}\`. First error line: \`${repair.section.firstErrorLine ?? 'unavailable'}\`.\n${additional}`;
}

export async function routePageDataRepair(
  tasks: RuntimeRepairRoutingDependencies['tasks'],
  store: Pick<WorkerStore, 'tasks'>,
  job: RuntimeRepairRoutingDependencies['job'],
  inbox: RuntimeRepairRoutingDependencies['inbox'],
  settings: RoutingSettings,
  repair: PageDataRepair,
): Promise<PageDataRepairRoute> {
  const target = pageDataRepairTarget(repair.section);
  const owner = target.producer && repair.owner?.brief.goal !== target.goal ? undefined : repair.owner;
  const existing = store
    .tasks()
    .find(
      (task) =>
        task.state !== 'cancelled' &&
        (!target.producer || task.brief.goal === target.goal) &&
        (task.brief.markdown.includes(`page-data-repair-key: ${repair.repairKey}`) ||
          (target.producer && task.id === owner?.id && ['ready', 'running', 'held', 'landing'].includes(task.state))),
    );
  if (!existing && owner && (await job.resumePageDataRepair({ ...repair, owner }))) return 'resumed';
  const goal = owner?.brief.goal ?? target.goal;
  const manager = owner?.brief.manager ?? (target.producer ? settings.integration.supermanager : goal);
  if (existing) {
    const evidence = pageDataRepairEvidence(repair);
    const evidencePath = join(settings.stateDirectory, 'page-data-repairs', `${repair.repairKey}.observed.md`);
    mkdirSync(dirname(evidencePath), { recursive: true });
    if (existsSync(evidencePath)) {
      if (readFileSync(evidencePath, 'utf8') !== evidence)
        throw new Error('page-data repair observation changed for an existing cause');
    } else writeFileSync(evidencePath, evidence, { flag: 'wx', mode: 0o600 });
    inbox.deliver({
      managerId: existing.brief.manager,
      taskId: existing.id,
      kind: 'instruction',
      summary: `Continue the current page-data repair with ${1 + (repair.additional?.length ?? 0)} retained section observations at ${repair.head}.`,
      evidencePath,
    });
    return 'dispatched';
  }
  const policy = settings.policy?.brief;
  const rules = riskAreaRulesFor(readRiskOwnership(settings.riskAreasFile, policy));
  const riskAreas = [...new Set(target.files.flatMap((path) => classifyRiskAreas(path, rules, 'pattern', policy)))];
  const markdown = pageDataRepairBrief(repair, goal, manager, riskAreas, target.files);
  const briefPath = join(settings.stateDirectory, 'page-data-repairs', `${repair.repairKey}.brief.md`);
  mkdirSync(dirname(briefPath), { recursive: true });
  if (existsSync(briefPath)) {
    const previous = readFileSync(briefPath, 'utf8');
    if (previous !== markdown) {
      // Replace only the exact unadmitted brief emitted by the previous generator.
      const previousGoal = repair.owner?.brief.goal ?? repair.section.goal;
      const previousManager = repair.owner?.brief.manager ?? previousGoal;
      const { additional: _additional, ...singleCause } = repair;
      const previousEmpty = pageDataRepairBrief(singleCause, previousGoal, previousManager, []);
      const currentEmpty = pageDataRepairBrief(repair, goal, manager, [], target.files);
      if (!repair.reconcileRiskRefusal || (previous !== previousEmpty && previous !== currentEmpty))
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
