import { isolatedIntegrationFiles } from './core.ts';
import { commandOnlyIntegrationFiles, rawSparqlIntegrationFiles } from './isolated-integration-files.ts';
import {
  integrationResourceClass,
  integrationResourceClasses,
  integrationTierBudget,
  qaResourceClasses,
  queuedProjectsBudget,
  type QaResourceClass,
} from './resource-classes.ts';

export interface IntegrationShard {
  files: string[];
  batches: string[][];
  resourceClass: QaResourceClass;
}

/** Only ordinary, shared-state integration projects can cross run boundaries. */
export function integrationStackPoolEligible(input: {
  tier: string; files: readonly string[]; keep?: boolean; backend?: boolean; persistent?: boolean;
}): boolean {
  return input.tier === 'integration' && !input.keep && !input.backend && !input.persistent
    && integrationResourceClass(input.files) === 'ordinary'
    && input.files.length > 0
    && input.files.every(file => !isolatedIntegrationFiles.has(file) && !commandOnlyIntegrationFiles.has(file));
}

/** 60% of the command budget. Integer arithmetic so 480s stays exactly 288s. */
export function integrationPlanLimitMs(budgetMs: number): number {
  return budgetMs * 6 / 10;
}

function projectBudgetMs(file: string): number {
  const resourceClass = integrationResourceClasses.get(file);
  return resourceClass ? qaResourceClasses[resourceClass].budgetMs : qaResourceClasses.ordinary.budgetMs;
}

/** Files whose own estimate exceeds 60% of the budget they would run under. */
export function integrationOverBudgetFiles(estimates: ReadonlyMap<string, number>): string[] {
  return [...estimates.keys()]
    .filter((file) => (estimates.get(file) ?? 0) > integrationPlanLimitMs(projectBudgetMs(file)))
    .sort();
}

export function integrationBudgetSummary(files: readonly string[]): string[] {
  return files.map((file) => `- Over the integration budget: ${file}`);
}

/** Ordinary selections that fit in the free slots keep the 480s tier wall.
 * A queue of ordinary projects uses the same scheduling allowance as heavy projects. */
export function integrationTierWallMs(
  classes: readonly QaResourceClass[],
  slots: number,
  projects: number,
): number {
  if (!Number.isInteger(projects) || projects < 0) throw new Error('Invalid integration project count');
  if (classes.every((name) => name === 'ordinary') && projects > slots) {
    return queuedProjectsBudget(classes.map((name) => qaResourceClasses[name].budgetMs), slots);
  }
  return integrationTierBudget(classes, slots);
}

function shardOf(files: string[], estimates: ReadonlyMap<string, number>, rawFiles: ReadonlySet<string>): IntegrationShard {
  const assemblerClasses = new Set(files.map(file => rawFiles.has(file)));
  if (assemblerClasses.size > 1) throw new Error('Integration shard mixes raw-SPARQL and product-assembler files');
  const shared = files.filter((file) => !isolatedIntegrationFiles.has(file));
  const isolated = files
    .filter((file) => isolatedIntegrationFiles.has(file))
    .sort((a, b) => estimates.get(b)! - estimates.get(a)! || a.localeCompare(b));
  return {
    files,
    resourceClass: integrationResourceClass(files),
    batches: [...(shared.length ? [shared] : []), ...isolated.map((file) => [file])],
  };
}

/** Longest-processing-time assignment with a min-heap of project totals. Grow
 * only when even the least loaded project cannot fit the next file. Sorting
 * once and updating the heap avoids rebuilding every possible project width. */
function packWithinLimit(
  estimates: ReadonlyMap<string, number>,
  count: number,
  limit: number,
): string[][] {
  if (!estimates.size) return [];
  const projects = Array.from({ length: Math.max(1, Math.min(count, estimates.size)) },
    (_, index) => ({ index, files: [] as string[], ms: 0 }));
  type Project = typeof projects[number];
  const heap = [...projects];
  const before = (a: Project, b: Project) => a.ms < b.ms || (a.ms === b.ms && a.index < b.index);
  const ordered = [...estimates].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [file, ms] of ordered) {
    if (heap[0]!.ms + ms > limit) {
      const project = { index: projects.length, files: [] as string[], ms: 0 };
      projects.push(project);
      heap.push(project);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!before(heap[index]!, heap[parent]!)) break;
        [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
        index = parent;
      }
    }
    const target = heap[0]!;
    target.files.push(file);
    target.ms += ms;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && before(heap[right]!, heap[left]!) ? right : left;
      if (!before(heap[child]!, heap[index]!)) break;
      [heap[index], heap[child]] = [heap[child]!, heap[index]!];
      index = child;
    }
  }
  return projects.filter(project => project.files.length).map(project => project.files.sort());
}

/** One stack/bootstrap per worker. Fresh-state files reset that stack between
 * commands; product-assembler probes retain their own persistent project.
 * `count` is the number of free slots. Projects beyond that wait, each with
 * its own command deadline. */
export function planIntegrationShards(
  estimates: ReadonlyMap<string, number>,
  count: number,
  rawFiles: ReadonlySet<string> = rawSparqlIntegrationFiles(),
): IntegrationShard[] {
  const ownProject = (file: string) =>
    commandOnlyIntegrationFiles.has(file) || integrationResourceClasses.has(file);
  const reusable = new Map([...estimates].filter(([file]) => !ownProject(file)));
  const persistent = [...estimates.keys()].filter(ownProject).sort();
  const limit = integrationPlanLimitMs(qaResourceClasses.ordinary.budgetMs);
  const planAssemblerClass = (files: Map<string, number>) => {
    const alone = [...files.keys()].filter((file) => (files.get(file) ?? 0) > limit).sort();
    for (const file of alone) files.delete(file);
    return [
      ...packWithinLimit(files, count, limit).map((group) => shardOf(group, estimates, rawFiles)),
      ...alone.map((file) => shardOf([file], estimates, rawFiles)),
    ];
  };
  const productAssembler = new Map([...reusable].filter(([file]) => !rawFiles.has(file)));
  const fixtureAssembler = new Map([...reusable].filter(([file]) => rawFiles.has(file)));
  return [
    ...planAssemblerClass(productAssembler),
    ...planAssemblerClass(fixtureAssembler),
    ...persistent.map((file) => shardOf([file], estimates, rawFiles)),
  ];
}

/** At most `slots` projects run at once. Each receives `budget` as its own
 * deadline, and a project past the free slots starts when a worker finishes. */
export async function runQueuedProjects<Project, Result>(
  projects: readonly Project[],
  slots: number,
  budget: number,
  run: (index: number, project: Project, budget: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(projects.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(slots, projects.length) }, async () => {
    while (next < projects.length) {
      const index = next++;
      results[index] = await run(index, projects[index]!, budget);
    }
  }));
  return results;
}
