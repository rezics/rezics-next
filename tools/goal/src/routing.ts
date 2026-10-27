import { readFileSync } from 'node:fs';
import type { Brief, Profile, TaskClass } from './types.ts';

// fallbacks are tried in order when no pool of the first profile's CLI has quota. A new task of a paced class goes to
// the allowed profile whose allowance most needs spending; `paced: false` keeps the order, for work that belongs on its
// first engine while that has quota.
export type Route = { first: Profile; fallbacks?: Profile[]; maxSteps: number; maxMs: number; paced?: boolean };
export type RoutingTable = {
  version: string; classes: Record<Exclude<TaskClass, 'mechanical'>, Route>;
  experiments: { name: string; class: TaskClass; open: boolean; profiles: Profile[] }[]; consultation: Profile;
};
export function readRouting(file: string): RoutingTable {
  const table = JSON.parse(readFileSync(file, 'utf8')) as RoutingTable;
  if (!table.version || !Array.isArray(table.experiments)) throw new Error('invalid routing table');
  const profile = (p: Profile) => {
    if (!p || !['codex', 'grok', 'cursor', 'claude'].includes(p.cli) || !p.model || !p.poolClass
      || !['low', 'medium', 'high', 'xhigh', 'max'].includes(p.effort)) throw new Error('invalid routing profile');
    if (p.model.includes('sol') && !['medium', 'high', 'low'].includes(p.effort)) throw new Error('Sol effort exceeds high');
    if (p.serviceTier !== undefined && !['default', 'fast'].includes(p.serviceTier)) throw new Error('invalid routing profile service tier');
  };
  for (const key of ['implementation', 'interface', 'bulk-text', 'claim', 'specification', 'critical-path', 'research'] as const) {
    const route = table.classes[key];
    if (!route || !(route.maxSteps > 0) || !(route.maxMs > 0)) throw new Error(`invalid route: ${key}`);
    if (route.paced !== undefined && typeof route.paced !== 'boolean') throw new Error(`invalid route paced: ${key}`);
    profile(route.first);
    (route.fallbacks ?? []).forEach(profile);
  }
  profile(table.consultation);
  if (table.consultation.cli !== 'codex' || !table.consultation.model.includes('sol') || table.consultation.effort !== 'medium') throw new Error('consultation must use Codex Sol medium');
  const open = new Set<TaskClass>();
  for (const experiment of table.experiments) {
    if (!experiment.profiles.length) throw new Error('empty experiment');
    experiment.profiles.forEach(profile);
    if (experiment.open && open.has(experiment.class)) throw new Error('multiple open experiments for a class');
    if (experiment.open) open.add(experiment.class);
  }
  return table;
}
/** A retry keeps its attempt's profile while that has quota; otherwise it reroutes as a new task of its class would. */
export function retryFallbacks(table: RoutingTable, taskClass: TaskClass): Profile[] {
  if (taskClass === 'mechanical') return [];
  const route = table.classes[taskClass];
  return route ? [route.first, ...(route.fallbacks ?? [])] : [];
}
export function classifyTask(brief: Brief): TaskClass {
  if (brief.kind === 'mechanical') return 'mechanical';
  if (brief.riskAreas.length || brief.citesSources || brief.hostileInput || brief.kind === 'claim') return 'claim';
  if (brief.kind === 'specification' || brief.kind === 'research') return brief.kind;
  if (brief.criticalPath && brief.waiting.length && brief.inseparable) return 'critical-path';
  if (brief.kind === 'interface' || brief.kind === 'bulk-text') return brief.kind;
  if (!brief.acceptance.failing || brief.estimate.lines > 400 || brief.estimate.files > 8)
    throw new Error('implementation needs failing acceptance tests and an estimate within 400 lines and 8 files; return it to its manager');
  return 'implementation';
}
export function routeTask(brief: Brief, sequence: number, table: RoutingTable): { taskClass: TaskClass; profile: Profile; tableVersion: string; experiment: string | null } {
  const taskClass = classifyTask(brief);
  if (taskClass === 'mechanical') throw new Error('mechanical work must run without a model');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid task sequence');
  const experiment = table.experiments.find(e => e.open && e.class === taskClass);
  return { taskClass, profile: experiment ? experiment.profiles[(sequence - 1) % experiment.profiles.length]! : table.classes[taskClass].first,
    tableVersion: table.version, experiment: experiment?.name ?? null };
}
