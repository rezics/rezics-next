import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import {
  isQaE2ePath,
  isQaFaultPath,
  isQaIntegrationPath,
  isQaLoadPath,
  isQaModelPath,
  isQaOwnerPath,
  legacyHostJenaGateFiles,
  testArgs,
  testExclusions,
  unitHarnessFiles,
} from './acceptance.ts';

// Affected-test selection for routine batches. It narrows what an agent runs;
// final acceptance still runs the complete backend suite through `task qa -- --backend`.

export type AffectedTier = 'unit' | 'owner' | 'integration' | 'model' | 'fault/recovery';
export const affectedTiers: AffectedTier[] = ['unit', 'owner', 'model', 'integration', 'fault/recovery'];

export interface GraphModule {
  source: string;
  dependencies: {
    module: string;
    resolved: string;
    couldNotResolve: boolean;
    coreModule: boolean;
  }[];
}

const frontendWorkspaces = ['apps/web', 'apps/accounts', 'packages/ui', 'apps/about'] as const;
export type FrontendWorkspace = typeof frontendWorkspaces[number];
export interface FrontendChecks {
  workspace: FrontendWorkspace;
  check: string;
  tests: string[];
  deferred: { command: string; reason: string }[];
}
const frontendWorkspace = (path: string): FrontendWorkspace | undefined =>
  frontendWorkspaces.find(workspace => path.startsWith(`${workspace}/`));

function frontendChecks(workspace: FrontendWorkspace): FrontendChecks {
  const browser = (command: string) => ({ command, reason: 'program tier; run explicitly' });
  const checks = {
    'apps/web': { check: 'web:typecheck', deferred: [browser('task storybook:test'), browser('task web:e2e')] },
    'apps/accounts': { check: 'accounts:typecheck', deferred: [browser('task accounts:storybook:test'), browser('task accounts:e2e')] },
    'packages/ui': { check: 'ui:typecheck', deferred: [browser('task storybook:test'), browser('task accounts:storybook:test'), browser('task web:e2e'), browser('task accounts:e2e')] },
    'apps/about': { check: 'about:check', deferred: [browser('task about:e2e')] },
  };
  return { workspace, tests: [], ...checks[workspace] };
}

export interface AffectedPlan {
  base: string;
  changed: string[];
  tasks: { task: string; because: string }[];
  frontend: FrontendChecks[];
  tests: Record<AffectedTier, string[]>;
  widened: { tier: AffectedTier; because: string }[];
  deferred: { file: string; reason: string }[];
  ignored: { path: string; reason: string }[];
  /** Set when the Dockerfile text is available: whether the native union test was selected. */
  nativeUnion?: 'selected' | 'not selected';
}

const codeFile = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const stackTiers: AffectedTier[] = ['model', 'integration', 'fault/recovery'];
// Inputs staged or read by jena-cli.ts, including the pinned image definition.
const jenaCheckInput = /^infra\/jena\/|^(?:model\/definitions|generated\/model\/shapes)\/.*\.ttl$|^tests\/fixtures\/jena-cli\/scratch\.trig$|^services\/main\/src\/modules\/query\/templates\/work-versions\.(?:rq|fixture\.json)$|^scripts\/qa\/jena-cli\.ts$|^infra\/dev\/compose\.yaml$/;
const sharedStackSmoke = 'tests/qa/integration/shared-stack.test.ts';
export const nativeUnionTest = 'infra/jena/tests/semantic-source-readiness-union.test.ts';
export const nativeUnionDockerfile = 'infra/jena/Dockerfile';
/** Shown on the affected plan so a gate can see why this unit file was or was not chosen. */
export const nativeModuleCopyInputs = 'native module COPY inputs';

export interface NativeModuleCopy {
  source: string;
  destination: string;
}

/** First Dockerfile stage: the native module build the union test reproduces. */
export function nativeModuleStage(dockerfile: string): string {
  return dockerfile.split(/\nFROM /, 1)[0] ?? '';
}

/** Module-stage COPY instructions. Unsupported syntax fails closed, matching the union test. */
export function nativeModuleCopies(dockerfile: string): NativeModuleCopy[] {
  const copies: NativeModuleCopy[] = [];
  for (const line of nativeModuleStage(dockerfile).split('\n')) {
    if (!/^COPY\s/.test(line)) continue;
    const copy = /^COPY (\S+) (\/build\/\S+)$/.exec(line);
    if (!copy) throw new Error(`unsupported native module COPY: ${line}`);
    copies.push({ source: copy[1]!, destination: copy[2]! });
  }
  return copies;
}

function coversNativeUnionInput(path: string, copies: readonly NativeModuleCopy[]): boolean {
  if (path === nativeUnionDockerfile || path === nativeUnionTest) return true;
  return copies.some(({ source }) => {
    const directory = source.endsWith('/') ? source : `${source}/`;
    return path === source || path === source.replace(/\/$/, '') || path.startsWith(directory);
  });
}
// The registered unit tier: `tests/qa/unit` plus its gate files.
const registeredUnit = [...testArgs('unit'), ...unitHarnessFiles];
const inRegisteredUnit = (path: string) =>
  registeredUnit.some((entry) => path === entry || path.startsWith(`${entry}/`));

type Rule = { match: RegExp; reason: string } & (
  | { effect: 'ignore' }
  | { effect: 'widen'; tiers: AffectedTier[] }
  | { effect: 'smoke' }
  | { effect: 'frontend' }
);

// Inputs that no import edge reaches. Order matters: the first match wins.
// Anything unmatched and unreferenced widens to every tier (fail closed).
export const inputRules: Rule[] = [
  {
    match: /^(?:apps\/(?:web|accounts|about)|packages\/ui)\//,
    effect: 'frontend',
    reason: 'frontend workspace checks',
  },
  {
    match: /^docs\/|\.md$|^(?:LICENSE|NOTICE)$/,
    effect: 'ignore',
    reason: 'documentation; run task docs:check',
  },
  {
    match: /^\.(?:claude|codex|github|vscode)\//,
    effect: 'ignore',
    reason: 'agent, editor or CI configuration',
  },
  {
    match: /^scripts\/documentation\//,
    effect: 'ignore',
    reason: 'documentation checker; run task docs:check',
  },
  {
    match: /^apps\/|^packages\/ui\//,
    effect: 'widen',
    tiers: affectedTiers,
    reason: 'unknown frontend workspace; no targeted checks registered',
  },
  {
    match:
      /^(?:\.oxfmtrc\.json|\.dependency-cruiser\.json|\.oxlintrc\.json|knip\.jsonc|sgconfig\.yml|\.gitignore|\.gitattributes|\.nvmrc)$|^scripts\/static\/ast-grep\/|(?:^|\/)tsconfig[^/]*\.json$/,
    effect: 'ignore',
    reason: 'static configuration; run task check:backend',
  },
  {
    match:
      /^(?:package\.json|yarn\.lock|\.yarnrc\.yml|bunfig\.toml)$|^\.yarn\/|^(?:services\/[^/]+|packages\/model|model)\/package\.json$/,
    effect: 'widen',
    tiers: affectedTiers,
    reason: 'dependency or runtime configuration',
  },
  {
    match: /^infra\/jena\/|^generated\/model\/shapes\//,
    effect: 'widen',
    tiers: stackTiers,
    reason: 'Fuseki image input',
  },
  {
    match: /^infra\/dev\//,
    effect: 'widen',
    tiers: stackTiers,
    reason: 'Compose stack definition',
  },
  {
    match: /^services\/[^/]+\/migrations\//,
    effect: 'widen',
    tiers: ['integration', 'fault/recovery'],
    reason: 'owner migration applied by the QA bootstrap',
  },
  {
    match: /^scripts\/dev\/|^scripts\/qa\/(?:bootstrap|cli|core)\.ts$/,
    effect: 'smoke',
    reason: 'stack harness started by root commands',
  },
];

export function classify(path: string): Rule | undefined {
  // Test and application code is tracked through imports; a stack-harness rule
  // adds its smoke test on top of that graph selection.
  const rule = inputRules.find((candidate) => candidate.match.test(path));
  if (
    codeFile.test(path) &&
    rule?.effect !== 'smoke' &&
    !path.startsWith('apps/') &&
    !path.startsWith('packages/ui/')
  )
    return undefined;
  return rule;
}

export function routeTest(path: string): { tier: AffectedTier } | { deferred: string } | { workspace: FrontendWorkspace } | undefined {
  const excluded = testExclusions.find(item => item.file === path && path.startsWith('apps/web/'));
  if (excluded) return { deferred: excluded.reason };
  const workspace = frontendWorkspace(path);
  if (workspace) return workspace === 'apps/about' || isQaE2ePath(path) ? undefined : { workspace };
  if (isQaE2ePath(path) || path.startsWith('apps/') || path.startsWith('packages/ui/'))
    return undefined;
  if ((legacyHostJenaGateFiles as readonly string[]).includes(path)) {
    return { deferred: 'legacy host-Jena test outside the QA registry' };
  }
  if (path.startsWith('tests/live/')) return { deferred: 'live network fixture; run explicitly' };
  if (isQaLoadPath(path))
    return { deferred: 'capacity tier; run explicitly with task test -- <file>' };
  if (isQaModelPath(path)) return { tier: 'model' };
  if (isQaIntegrationPath(path)) return { tier: 'integration' };
  if (isQaFaultPath(path)) return { tier: 'fault/recovery' };
  return { tier: isQaOwnerPath(path) ? 'owner' : 'unit' };
}

function referencedBy(path: string, sources: Map<string, string>, data: boolean): string[] {
  const needles = [path];
  if (data) {
    if (dirname(path) !== '.') needles.push(`${dirname(path)}/`);
    const name = basename(path);
    // Short or generic names would match unrelated modules; those fall back to widening.
    if (name.length >= 12 && /[-_]/.test(name)) needles.push(name);
  }
  return [...sources]
    .filter(([source, text]) => source !== path && needles.some((needle) => text.includes(needle)))
    .map(([source]) => source);
}

export function planAffected(input: {
  base: string;
  changed: string[];
  graph: GraphModule[];
  sources: Map<string, string>;
  exists: (path: string) => boolean;
  scriptOnlyManifests?: ReadonlySet<string>;
  /** Dockerfile text. When present, the native union test follows its module-stage COPY inputs. */
  nativeUnionDockerfile?: string;
}): AffectedPlan {
  const reverse = new Map<string, Set<string>>();
  const unresolvedImporters = new Map<string, Set<string>>();
  for (const module of input.graph) {
    for (const dependency of module.dependencies) {
      if (dependency.coreModule) continue;
      const target = dependency.couldNotResolve
        ? posix.normalize(posix.join(posix.dirname(module.source), dependency.module))
        : dependency.resolved;
      const index = dependency.couldNotResolve ? unresolvedImporters : reverse;
      if (!index.has(target)) index.set(target, new Set());
      index.get(target)!.add(module.source);
    }
  }
  const plan: AffectedPlan = {
    base: input.base,
    changed: [...input.changed].sort(),
    tasks: [],
    frontend: [],
    tests: { unit: [], owner: [], integration: [], model: [], 'fault/recovery': [] },
    widened: [],
    deferred: [],
    ignored: [],
  };
  const widen = (tiers: AffectedTier[], because: string) => {
    for (const tier of tiers)
      if (!plan.widened.some((item) => item.tier === tier)) plan.widened.push({ tier, because });
  };
  const frontend = (workspace: FrontendWorkspace) => {
    let checks = plan.frontend.find(item => item.workspace === workspace);
    if (!checks) { checks = frontendChecks(workspace); plan.frontend.push(checks); }
    return checks;
  };
  const seeds = new Set<string>();
  // The union test reproduces the Dockerfile's first-stage COPY set. Stack-tier
  // widening for infra/jena stays in place; this unit file follows that COPY set.
  const nativeCopies = input.nativeUnionDockerfile === undefined
    ? undefined
    : nativeModuleCopies(input.nativeUnionDockerfile);
  let nativeUnionTouched = false;
  for (const path of plan.changed) {
    if (nativeCopies && coversNativeUnionInput(path, nativeCopies)) nativeUnionTouched = true;
    if (jenaCheckInput.test(path) && !plan.tasks.some(check => check.task === 'jena:check'))
      plan.tasks.push({ task: 'jena:check', because: `${path}: pinned Jena CLI input` });
    // A root script edit changes command wiring, not installed dependencies.
    const rule = input.scriptOnlyManifests?.has(path)
      ? { match: /$^/, effect: 'smoke' as const, reason: 'root command wiring' }
      : classify(path);
    if (rule?.effect === 'frontend') {
      frontend(frontendWorkspace(path)!);
      // About owns its full cheap check. Other workspaces use import edges for targeted tests.
      if (frontendWorkspace(path) === 'apps/about') continue;
      if (!codeFile.test(path)) {
        if (input.exists(path)) seeds.add(path);
        for (const source of referencedBy(path, input.sources, true))
          if (frontendWorkspace(source)) seeds.add(source);
        continue;
      }
    }
    if (rule?.effect === 'ignore') {
      plan.ignored.push({ path, reason: rule.reason });
      continue;
    }
    if (rule?.effect === 'widen') {
      widen(rule.tiers, `${path}: ${rule.reason}`);
      continue;
    }
    if (rule?.effect === 'smoke') {
      if (input.exists(sharedStackSmoke)) seeds.add(sharedStackSmoke);
      if (!codeFile.test(path)) continue;
    }
    const present = input.exists(path);
    if (codeFile.test(path)) {
      if (present) seeds.add(path);
      else
        for (const importer of [...unresolvedImporters]
          .filter(([target]) => target === path || target === path.replace(codeFile, ''))
          .flatMap(([, importers]) => [...importers]))
          seeds.add(importer);
      // Scripts started as subprocesses are referenced by path rather than imported.
      for (const source of referencedBy(path, input.sources, false)) seeds.add(source);
      continue;
    }
    const references = referencedBy(path, input.sources, true);
    if (!references.length) {
      widen(affectedTiers, `${path}: unclassified input with no code reference`);
      continue;
    }
    for (const source of references) seeds.add(source);
  }
  if (nativeUnionTouched && input.exists(nativeUnionTest)) seeds.add(nativeUnionTest);
  const affected = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const current = queue.pop()!;
    if (affected.has(current)) continue;
    affected.add(current);
    for (const importer of reverse.get(current) ?? [])
      if (!affected.has(importer)) queue.push(importer);
  }
  if (nativeCopies && !nativeUnionTouched) affected.delete(nativeUnionTest);
  if (nativeCopies) plan.nativeUnion = nativeUnionTouched && input.exists(nativeUnionTest) ? 'selected' : 'not selected';
  // A widened tier runs its registered default selection, which for unit is
  // `tests/qa/unit` plus gate files; affected unit tests outside it still run.
  const unitWidened = plan.widened.some((item) => item.tier === 'unit');
  for (const path of [...affected]
    .filter((path) => testFile.test(path) && input.exists(path))
    .sort()) {
    const route = routeTest(path);
    if (!route) continue;
    if ('workspace' in route) frontend(route.workspace).tests.push(path);
    else if ('deferred' in route) plan.deferred.push({ file: path, reason: route.deferred });
    else if (
      route.tier === 'unit'
        ? !(unitWidened && inRegisteredUnit(path))
        : !plan.widened.some((item) => item.tier === route.tier)
    ) {
      plan.tests[route.tier].push(path);
    }
  }
  plan.frontend.sort((a, b) => frontendWorkspaces.indexOf(a.workspace) - frontendWorkspaces.indexOf(b.workspace));
  plan.widened.sort((a, b) => affectedTiers.indexOf(a.tier) - affectedTiers.indexOf(b.tier));
  return plan;
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function changedPaths(root: string, ref?: string): { base: string; changed: string[] } {
  // Default base: where this branch left main, so a worker branch includes its
  // commits and on main only uncommitted work counts.
  const base = ref
    ? git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim()
    : git(root, ['merge-base', 'HEAD', 'main']).trim();
  const tracked = git(root, ['diff', '--name-only', '--no-renames', '-z', base]).split('\0');
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  return { base, changed: [...new Set([...tracked, ...untracked].filter(Boolean))] };
}

const graphRoots = [
  'services',
  'packages/model',
  'packages/document',
  'model',
  'scripts',
  'tests',
  'infra',
];

export function backendGraph(root: string, includeFrontend = false): GraphModule[] {
  const result = spawnSync(
    join(root, 'node_modules/.bin/depcruise'),
    [
      '--no-config',
      '--do-not-follow',
      'node_modules',
      '--exclude',
      '(^|/)node_modules/|^[.]temp/|^[.]yarn/',
      '--ts-pre-compilation-deps',
      '--output-type',
      'json',
      ...graphRoots,
      ...(includeFrontend ? ['apps/web', 'apps/accounts', 'packages/ui'] : []),
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`dependency-cruiser failed: ${result.stderr.trim()}`);
  const modules = (JSON.parse(result.stdout) as { modules: GraphModule[] }).modules;
  if (!modules.some((module) => module.source.startsWith('services/main/src/'))) {
    throw new Error('dependency-cruiser returned no backend modules');
  }
  return resolveWorkspaceImports(root, modules);
}

// Workspace packages export TypeScript entrypoints under `types` conditions that
// the analyzer does not resolve; map them to their source files.
function resolveWorkspaceImports(root: string, modules: GraphModule[]): GraphModule[] {
  const exportsByPackage = new Map<string, Record<string, unknown>>();
  for (const directory of [
    'services/main',
    'services/account',
    'services/content',
    'packages/model',
    'packages/document',
    'packages/ui',
  ]) {
    const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')) as {
      name: string;
      exports?: Record<string, unknown>;
    };
    exportsByPackage.set(
      manifest.name,
      Object.fromEntries(
        Object.entries(manifest.exports ?? {}).map(([key, value]) => [key, { directory, value }]),
      ),
    );
  }
  const target = (specifier: string): string | undefined => {
    const [, name, subpath] = /^(@rezics\/[^/]+)(\/.*)?$/.exec(specifier) ?? [];
    const entry = name
      ? (exportsByPackage.get(name)?.[`.${subpath ?? ''}`] as
          | { directory: string; value: unknown }
          | undefined)
      : undefined;
    if (!entry) return undefined;
    const value =
      typeof entry.value === 'string'
        ? entry.value
        : (Object.values(entry.value as Record<string, unknown>).find(
            (item) => typeof item === 'string',
          ) as string | undefined);
    return value ? posix.join(entry.directory, value) : undefined;
  };
  return modules.map((module) => ({
    ...module,
    dependencies: module.dependencies.map((dependency) => {
      let resolved = dependency.couldNotResolve ? target(dependency.module) : undefined;
      // Each app's @/ alias is relative to that workspace, not the repository.
      const workspace = frontendWorkspace(module.source);
      if (!resolved && dependency.couldNotResolve && dependency.module.startsWith('@/')
        && (workspace === 'apps/web' || workspace === 'apps/accounts')) {
        const base = posix.join(workspace, dependency.module.slice(2));
        resolved = [base, ...['.ts', '.tsx', '.js', '.jsx', '.json'].map(extension => `${base}${extension}`),
          ...['.ts', '.tsx', '.js', '.jsx'].map(extension => `${base}/index${extension}`)]
          .find(path => existsSync(join(root, path)));
      }
      return resolved ? { ...dependency, resolved, couldNotResolve: false } : dependency;
    }),
  }));
}

function scriptOnlyManifests(root: string, base: string, changed: string[]): Set<string> {
  const result = new Set<string>();
  if (!changed.includes('package.json') || !existsSync(join(root, 'package.json'))) return result;
  const shown = spawnSync('git', ['show', `${base}:package.json`], { cwd: root, encoding: 'utf8' });
  if (shown.status !== 0) return result;
  const withoutScripts = (text: string) => {
    const { scripts: _scripts, ...rest } = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(rest);
  };
  if (
    withoutScripts(shown.stdout) ===
    withoutScripts(readFileSync(join(root, 'package.json'), 'utf8'))
  ) {
    result.add('package.json');
  }
  return result;
}

// Only graph-selected tests need the graph; a change set that is entirely ignored
// or widened selects none.
export function needsGraph(
  changed: string[],
  scriptOnly: ReadonlySet<string> = new Set(),
): boolean {
  return changed.some(
    (path) => scriptOnly.has(path) || (classify(path)?.effect === 'frontend'
      ? frontendWorkspace(path) !== 'apps/about'
      : !['ignore', 'widen'].includes(classify(path)?.effect ?? '')),
  );
}

export function affectedPlan(root: string, ref?: string): AffectedPlan {
  const { base, changed } = changedPaths(root, ref);
  const manifests = scriptOnlyManifests(root, base, changed);
  const graph = needsGraph(changed, manifests) ? backendGraph(root, changed.some(path => frontendWorkspace(path) !== undefined)) : [];
  const sources = new Map<string, string>();
  for (const module of graph) {
    const path = join(root, module.source);
    if (codeFile.test(module.source) && existsSync(path))
      sources.set(module.source, readFileSync(path, 'utf8'));
  }
  const dockerfile = join(root, nativeUnionDockerfile);
  return planAffected({
    base,
    changed,
    graph,
    sources,
    exists: (path) => existsSync(resolve(root, path)),
    scriptOnlyManifests: manifests,
    nativeUnionDockerfile: existsSync(dockerfile) ? readFileSync(dockerfile, 'utf8') : '',
  });
}

export function formatPlan(plan: AffectedPlan): string {
  const lines = [`Affected since ${plan.base.slice(0, 12)}: ${plan.changed.length} changed paths`];
  for (const { task, because } of plan.tasks) lines.push(`  task ${task} (${because})`);
  if (plan.nativeUnion) lines.push(`  ${nativeModuleCopyInputs}: ${plan.nativeUnion}`);
  for (const { tier, because } of plan.widened) lines.push(`  ${tier}: whole tier (${because})`);
  for (const tier of affectedTiers) {
    for (const file of plan.tests[tier]) lines.push(`  ${tier}: ${file}`);
  }
  for (const checks of plan.frontend) {
    lines.push(`  ${checks.workspace}: task ${checks.check}`);
    for (const file of checks.tests) lines.push(`  ${checks.workspace}: task test -- ${file}`);
    if (!checks.tests.length && checks.workspace !== 'apps/about')
      lines.push(`  ${checks.workspace}: no targeted unit/component tests found; workspace type check runs`);
    for (const { command, reason } of checks.deferred) lines.push(`  not run: ${command} (${reason})`);
  }
  for (const { file, reason } of plan.deferred) lines.push(`  not run: ${file} (${reason})`);
  const reasons = [...new Set(plan.ignored.map((item) => item.reason))];
  if (reasons.length)
    lines.push(`  no tests for ${plan.ignored.length} paths: ${reasons.join('; ')}`);
  if (!plan.tasks.length && !plan.frontend.length && !plan.widened.length && affectedTiers.every((tier) => !plan.tests[tier].length)) {
    lines.push('  no affected backend tests');
  }
  return lines.join('\n');
}
