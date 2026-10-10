import { isolatedIntegrationFiles, planShards } from './core.ts';
import { commandOnlyIntegrationFiles } from './isolated-integration-files.ts';
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

function shardOf(files: string[], estimates: ReadonlyMap<string, number>): IntegrationShard {
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

/** Longest-processing-time assignment into `count` projects, widened until each
 * ordinary project is within 60% of its budget. A single file past that line
 * cannot be split, so it is returned alone. */
function packWithinLimit(
  estimates: ReadonlyMap<string, number>,
  count: number,
  limit: number,
): string[][] {
  if (!estimates.size) return [];
  const sum = (files: readonly string[]) => files.reduce((total, file) => total + (estimates.get(file) ?? 0), 0);
  let width = Math.max(1, Math.min(count, estimates.size));
  let plan = planShards(estimates, width);
  while (plan.some((files) => sum(files) > limit) && width < estimates.size) {
    width += 1;
    plan = planShards(estimates, width);
  }
  return plan;
}

/** One stack/bootstrap per worker. Fresh-state files reset that stack between
 * commands; product-assembler probes retain their own persistent project.
 * `count` is the number of free slots. Projects beyond that wait, each with
 * its own command deadline. */
export function planIntegrationShards(
  estimates: ReadonlyMap<string, number>,
  count: number,
): IntegrationShard[] {
  const ownProject = (file: string) =>
    commandOnlyIntegrationFiles.has(file) || integrationResourceClasses.has(file);
  const reusable = new Map([...estimates].filter(([file]) => !ownProject(file)));
  const persistent = [...estimates.keys()].filter(ownProject).sort();
  const limit = integrationPlanLimitMs(qaResourceClasses.ordinary.budgetMs);
  const alone = [...reusable.keys()].filter((file) => (reusable.get(file) ?? 0) > limit).sort();
  for (const file of alone) reusable.delete(file);
  return [
    ...packWithinLimit(reusable, count, limit).map((files) => shardOf(files, estimates)),
    ...alone.map((file) => shardOf([file], estimates)),
    ...persistent.map((file) => shardOf([file], estimates)),
  ];
}
