import { agentAdapter, isAgentCli, pinnedModelProfile, requireOriginalProofProfile } from './agents.ts';
import { readFileSync } from 'node:fs';
import type { Brief, Effort, Profile, TaskClass } from './types.ts';

// fallbacks are tried in order when no pool of the first profile's CLI has quota. A new task of a paced class goes to
// the allowed profile whose allowance most needs spending; `paced: false` keeps the order, for work that belongs on its
// first engine while that has quota.
export type Route = { first: Profile; fallbacks?: Profile[]; maxSteps: number; maxMs: number; paced?: boolean };
export type RoutingTable = {
  version: string;
  classes: Record<Exclude<TaskClass, 'mechanical'>, Route>;
  experiments: { name: string; class: TaskClass; open: boolean; profiles: Profile[] }[];
  consultation: Profile;
};
const ROUTED_CLASSES = [
  'implementation',
  'interface',
  'bulk-text',
  'claim',
  'specification',
  'critical-path',
  'research',
] as const satisfies readonly Exclude<TaskClass, 'mechanical'>[];
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function finitePositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`invalid ${label}`);
  return value;
}
function parseProfile(value: unknown, label: string): Profile {
  const profile = object(value, label);
  if (!isAgentCli(profile.cli)) throw new Error(`invalid ${label}.cli`);
  if (typeof profile.effort !== 'string' || !EFFORTS.includes(profile.effort as Effort))
    throw new Error(`invalid ${label}.effort`);
  if (profile.serviceTier !== undefined && profile.serviceTier !== 'default')
    throw new Error('routing profiles cannot choose a service tier other than default; the tier is a setting');
  return {
    cli: profile.cli,
    model: text(profile.model, `${label}.model`),
    effort: profile.effort as Effort,
    poolClass: text(profile.poolClass, `${label}.poolClass`),
    ...(profile.serviceTier === undefined ? {} : { serviceTier: 'default' as const }),
  };
}
function parseRoute(value: unknown, label: string): Route {
  const route = object(value, label);
  const first = parseProfile(route.first, `${label}.first`);
  let fallbacks: Profile[] | undefined;
  if (route.fallbacks !== undefined) {
    if (!Array.isArray(route.fallbacks)) throw new Error(`${label}.fallbacks must be an array`);
    fallbacks = route.fallbacks.map((item, index) => parseProfile(item, `${label}.fallbacks[${index}]`));
  }
  if (route.paced !== undefined && typeof route.paced !== 'boolean') throw new Error(`invalid ${label}.paced`);
  return {
    first,
    ...(fallbacks === undefined ? {} : { fallbacks }),
    maxSteps: finitePositive(route.maxSteps, `${label}.maxSteps`),
    maxMs: finitePositive(route.maxMs, `${label}.maxMs`),
    ...(route.paced === undefined ? {} : { paced: route.paced }),
  };
}
function parseExperiment(value: unknown, label: string): RoutingTable['experiments'][number] {
  const experiment = object(value, label);
  if (typeof experiment.class !== 'string' || !(ROUTED_CLASSES as readonly string[]).includes(experiment.class))
    throw new Error(`invalid ${label}.class`);
  if (typeof experiment.open !== 'boolean') throw new Error(`invalid ${label}.open`);
  if (!Array.isArray(experiment.profiles)) throw new Error(`${label}.profiles must be an array`);
  if (!experiment.profiles.length) throw new Error(`empty ${label}.profiles`);
  return {
    name: text(experiment.name, `${label}.name`),
    class: experiment.class as Exclude<TaskClass, 'mechanical'>,
    open: experiment.open,
    profiles: experiment.profiles.map((item, index) => parseProfile(item, `${label}.profiles[${index}]`)),
  };
}
/** Validate a routing document at the configuration boundary; every error names the responsible field. */
export function parseRouting(value: unknown): RoutingTable {
  const table = object(value, 'routing');
  const classesValue = object(table.classes, 'classes');
  const classes = {} as RoutingTable['classes'];
  for (const key of ROUTED_CLASSES) classes[key] = parseRoute(classesValue[key], `classes.${key}`);
  if (!Array.isArray(table.experiments)) throw new Error('experiments must be an array');
  const open = new Set<TaskClass>();
  const experiments = table.experiments.map((item, index) => {
    const experiment = parseExperiment(item, `experiments[${index}]`);
    if (experiment.open && open.has(experiment.class))
      throw new Error(`multiple open experiments for class ${experiment.class}`);
    if (experiment.open) open.add(experiment.class);
    return experiment;
  });
  const consultation = parseProfile(table.consultation, 'consultation');
  if (agentAdapter(consultation.cli).supportsConsultation?.(consultation) === false)
    throw new Error('consultation must use Codex Sol medium');
  // Routing files number their versions; a positive integer is read as its label.
  const version =
    typeof table.version === 'number' && Number.isSafeInteger(table.version) && table.version > 0
      ? String(table.version)
      : text(table.version, 'version');
  return { version, classes, experiments, consultation };
}
export function readRouting(file: string): RoutingTable {
  return parseRouting(JSON.parse(readFileSync(file, 'utf8')));
}
/** A retry keeps its attempt's profile while that has quota; otherwise it reroutes as a new task of its class would. */
export function retryFallbacks(table: RoutingTable, taskClass: TaskClass): Profile[] {
  if (taskClass === 'mechanical') return [];
  const route = table.classes[taskClass];
  return route ? [route.first, ...(route.fallbacks ?? [])] : [];
}
export function classifyTask(brief: Brief): TaskClass {
  if (brief.kind === 'verification') return 'implementation';
  if (brief.kind === 'mechanical') return 'mechanical';
  // Research cites sources by nature; it keeps its own route (web search, the research model) instead of becoming a claim.
  if (brief.kind === 'research') return 'research';
  if (brief.riskAreas.length || brief.citesSources || brief.hostileInput || brief.kind === 'claim') return 'claim';
  if (brief.kind === 'specification') return brief.kind;
  if (brief.criticalPath && brief.waiting.length && brief.inseparable) return 'critical-path';
  if (brief.kind === 'interface' || brief.kind === 'bulk-text') return brief.kind;
  // A brief is one user journey of about 2,000-3,000 lines across backend and interface (docs/development/efficiency.md).
  if (!brief.acceptance.failing || brief.estimate.lines > 4000 || brief.estimate.files > 60)
    throw new Error(
      'implementation needs failing acceptance tests and an estimate within 4000 lines and 60 files; return it to its manager',
    );
  return 'implementation';
}
export function routeTask(
  brief: Brief,
  sequence: number,
  table: RoutingTable,
): { taskClass: TaskClass; profile: Profile; tableVersion: string; experiment: string | null } {
  const taskClass = classifyTask(brief);
  if (taskClass === 'mechanical') throw new Error('mechanical work must run without a model');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid task sequence');
  if (brief.kind === 'verification') {
    const profile = table.classes.implementation.first;
    requireOriginalProofProfile(profile);
    return { taskClass, profile, tableVersion: table.version, experiment: null };
  }
  // A brief may pin its Codex model and effort, for example a deep research question on Sol max beside a Terra copy.
  if (brief.model !== undefined) {
    const profile = pinnedModelProfile(brief.model, brief.effort, table.classes[taskClass].first);
    return { taskClass, profile, tableVersion: table.version, experiment: null };
  }
  const experiment = table.experiments.find((e) => e.open && e.class === taskClass);
  return {
    taskClass,
    profile: experiment
      ? experiment.profiles[(sequence - 1) % experiment.profiles.length]!
      : table.classes[taskClass].first,
    tableVersion: table.version,
    experiment: experiment?.name ?? null,
  };
}
