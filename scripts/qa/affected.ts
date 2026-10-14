import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import {
  isQaE2ePath,
  isQaFaultPath,
  isQaIntegrationPath,
  isQaLoadPath,
  isQaModelPath,
  isQaOwnerPath,
  erasureCampaignNativeTest,
  heldReplayNativeTest,
  inputSelectedNativeTests,
  nativeProofDeclarations,
  legacyHostJenaGateFiles,
  nativeIntegerPreservationTest,
  nativeUnionTest,
  ownerTierFiles as affectedOwnerTierEntries,
  testArgs,
  testExclusions,
  unitHarnessFiles,
  workNameScopeBasisTest,
} from './acceptance.ts';
import { expandTestPaths } from './core.ts';
import { WORK_PROFILE_SEED_BUILD_FILE } from './preparation-selection.ts';
import { dockerfileCopySources } from '../dev/fuseki-image.ts';
import { selectRepositoryGuards } from './repository-guards.ts';

export { affectedOwnerTierEntries };

export {
  erasureCampaignNativeTest,
  heldReplayNativeTest,
  inputSelectedNativeTests,
  nativeIntegerPreservationTest,
  nativeUnionTest,
  workNameScopeBasisTest,
};

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
  /** Set when Dockerfile text is available: whether declared image COPY inputs selected native proofs. */
  nativeModuleCopySelection?: 'selected' | 'not selected' | 'unsupported COPY syntax, selected';
}

const codeFile = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const stackTiers: AffectedTier[] = ['model', 'integration', 'fault/recovery'];
// Inputs staged or read by jena-cli.ts, including the pinned image definition.
const jenaCheckInput = /^infra\/jena\/|^(?:model\/definitions|generated\/model\/shapes)\/.*\.ttl$|^tests\/fixtures\/jena-cli\/scratch\.trig$|^services\/main\/src\/modules\/query\/templates\/work-versions\.(?:rq|fixture\.json)$|^scripts\/qa\/jena-cli\.ts$|^infra\/dev\/compose\.yaml$/;
const sharedStackSmoke = 'tests/qa/integration/shared-stack.test.ts';
// Docker/Maven proofs selected from the module-stage COPY set. Checks that need
// no native image under infra/jena/tests stay on the ordinary unit tier.
export const nativeModuleDockerfile = 'infra/jena/Dockerfile';
/** Shown on the affected plan so a gate can see why native proof files were or were not selected. */
export const nativeModuleCopyInputs = 'native module COPY inputs';
const inputSelectedNative = new Set<string>(inputSelectedNativeTests);

export interface NativeModuleCopy {
  source: string;
  destination: string;
}

/** First Dockerfile stage: the native module build used by input-selected proofs. */
export function nativeModuleStage(dockerfile: string): string {
  return dockerfile.split(/\nFROM /, 1)[0] ?? '';
}

/** Module-stage COPY instructions. Unsupported syntax throws; the union test depends on that refusal. */
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

function copySourceCovers(path: string, copies: readonly NativeModuleCopy[]): boolean {
  return copies.some(({ source }) => {
    const directory = source.endsWith('/') ? source : `${source}/`;
    return path === source || path === source.replace(/\/$/, '') || path.startsWith(directory);
  });
}

/** Each proof follows its declared image scope. A change to one proof selects only that file. */
function nativeFilesTouchedBy(path: string, copies: readonly NativeModuleCopy[], runtimeSources: readonly string[]): readonly string[] {
  if (inputSelectedNative.has(path)) return [path];
  return nativeProofDeclarations.filter(proof => path === nativeModuleDockerfile
    || copySourceCovers(path, copies)
    || (proof.imageInputs === 'fuseki' && copySourceCovers(path,
      runtimeSources.map(source => ({ source, destination: '' }))))).map(proof => proof.file);
}

/** Registered unit files a widened tier runs. Registry files are omitted; they are listed only when their COPY rule matched. */
export function affectedUnitTierEntries(): string[] {
  return [...testArgs('unit'), ...unitHarnessFiles].filter((file) => !inputSelectedNative.has(file));
}

/** File list for a widened unit command. Directories are expanded because the QA CLI accepts only test files. */
export function affectedUnitTierFiles(root: string): string[] {
  return expandTestPaths(root, affectedUnitTierEntries());
}

// The registered unit tier: `tests/qa/unit` plus its gate files.
const registeredUnit = [...testArgs('unit'), ...unitHarnessFiles];
const inRegisteredUnit = (path: string) =>
  registeredUnit.some((entry) => path === entry || path.startsWith(`${entry}/`));
const registeredOwner = testArgs('owner');
const inRegisteredOwner = (path: string) =>
  registeredOwner.some((entry) => path === entry || path.startsWith(`${entry}/`));

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
  if (path === WORK_PROFILE_SEED_BUILD_FILE)
    return { deferred: 'Retained seed preparation; select its build command explicitly alone' };
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

function referenceNeedles(path: string, data: boolean): string[] {
  const needles = [path];
  if (data) {
    if (dirname(path) !== '.') needles.push(`${dirname(path)}/`);
    const name = basename(path);
    // Short or generic names would match unrelated modules; those fall back to widening.
    if (name.length >= 12 && /[-_]/.test(name)) needles.push(name);
  }
  return needles;
}

/** Match every changed input in one source traversal. Repeated substring scans
 * used to multiply the changed-file count by the whole source inventory. */
function referenceIndex(paths: readonly string[], sources: Map<string, string>) {
  interface Node { next: Map<string, Node>; failure?: Node; output?: Node; needle?: string }
  const root: Node = { next: new Map() };
  root.failure = root;
  const matches = new Map<string, Set<string>>();
  for (const path of paths) for (const needle of referenceNeedles(path, !codeFile.test(path))) {
    if (matches.has(needle)) continue;
    matches.set(needle, new Set());
    let node = root;
    for (const character of needle) {
      let child = node.next.get(character);
      if (!child) { child = { next: new Map() }; node.next.set(character, child); }
      node = child;
    }
    node.needle = needle;
  }
  const queue = [...root.next.values()];
  for (const node of queue) node.failure = root;
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    for (const [character, child] of node.next) {
      let fallback = node.failure!;
      while (fallback !== root && !fallback.next.has(character)) fallback = fallback.failure!;
      child.failure = fallback.next.get(character) ?? root;
      child.output = child.failure.needle ? child.failure : child.failure.output;
      queue.push(child);
    }
  }
  if (matches.size) for (const [source, text] of sources) {
    // Keep small selections on the runtime's native substring search. The
    // fixed cap preserves linear source work without scanning every character
    // in JavaScript for the usual handful of changed inputs.
    if (matches.size <= 32) {
      for (const [needle, files] of matches) if (text.includes(needle)) files.add(source);
      continue;
    }
    let node = root;
    const found = new Set<string>();
    for (const character of text) {
      while (node !== root && !node.next.has(character)) node = node.failure!;
      node = node.next.get(character) ?? root;
      for (let output: Node | undefined = node; output; output = output.output)
        if (output.needle) found.add(output.needle);
    }
    for (const needle of found) matches.get(needle)!.add(source);
  }
  return (path: string, data: boolean): string[] => [...new Set(referenceNeedles(path, data)
    .flatMap(needle => [...(matches.get(needle) ?? [])]))].filter(source => source !== path);
}

/** Workspaces with a `<workspace>:typecheck` task, by the directories whose sources they check. Each task checks one
 * TypeScript project: Task stops at the first failing command, so a second project would hide its errors.
 * A longer root owns a file that also sits under a shorter one, so dataset tools are not checked as ordinary scripts. */
export const TYPECHECK_WORKSPACES: ReadonlyArray<readonly [workspace: string, roots: readonly string[]]> = [
  ['main', ['services/main/']],
  ['account', ['services/account/']],
  ['content', ['services/content/']],
  ['web', ['apps/web/']],
  ['accounts', ['apps/accounts/']],
  ['model', ['packages/model/']],
  ['ui', ['packages/ui/']],
  ['document', ['packages/document/']],
  ['observability', ['packages/observability/']],
  ['dataset', ['scripts/datasets/']],
  ['scripts', ['scripts/']],
  ['apphost', ['apphost/']],
];

const TYPECHECK_SOURCE = /\.[cm]?tsx?$|(?:^|\/)(?:tsconfig[^/]*|package)\.json$/;

/** Ask the TypeScript project which files its imports bring in, including transitive and type-only imports. */
function scriptsProjectFiles(root: string, graph?: readonly GraphModule[]): ReadonlySet<string> {
  const config = join(root, 'scripts/tsconfig.json');
  if (!existsSync(config)) return new Set();
  // Most selections need only directory ownership; load the compiler only for external test sources.
  const ts = createRequire(import.meta.url)('typescript-6') as typeof import('typescript-6');
  const loaded = ts.readConfigFile(config, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const project = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(config));
  if (project.errors.length) throw new Error(project.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  if (graph) {
    // Affected planning has already resolved the complete pre-compilation graph.
    // Reuse its edges instead of reading and resolving the same sources again.
    const modules = new Map(graph.map(module => [resolve(root, module.source), module]));
    if (project.fileNames.every(file => modules.has(resolve(file)))) {
      const imported = new Set<string>();
      const pending = [...project.fileNames];
      while (pending.length) {
        const file = resolve(pending.pop()!);
        if (imported.has(file)) continue;
        imported.add(file);
        if (project.options.noResolve) continue;
        for (const dependency of modules.get(file)?.dependencies ?? [])
          if (!dependency.coreModule && !dependency.couldNotResolve) pending.push(resolve(root, dependency.resolved));
      }
      return imported;
    }
  }
  // Selection needs membership, not parsed ASTs, library declarations or type
  // checking. Use the compiler's scanner and resolver to follow each local
  // import once, including type-only imports and triple-slash references.
  const imported = new Set<string>();
  const pending = [...project.fileNames];
  const cache = ts.createModuleResolutionCache(root, file => file, project.options);
  while (pending.length) {
    const file = resolve(pending.pop()!);
    if (imported.has(file)) continue;
    imported.add(file);
    if (file.includes('/node_modules/')) continue;
    const source = ts.sys.readFile(file);
    if (source === undefined) continue;
    const references = ts.preProcessFile(source, true, /\.[cm]?jsx?$/.test(file));
    if (project.options.noResolve) continue;
    for (const reference of references.referencedFiles) pending.push(resolve(dirname(file), reference.fileName));
    for (const reference of references.importedFiles) {
      const dependency = ts.resolveModuleName(reference.fileName, file, project.options, ts.sys, cache).resolvedModule;
      if (!dependency) continue;
      if (!project.options.allowJs && /\.[cm]?jsx?$/.test(dependency.resolvedFileName)) continue;
      pending.push(dependency.resolvedFileName);
    }
  }
  return imported;
}

/** Each workspace a changed TypeScript source or its config belongs to, once. */
export function typecheckWorkspaces(files: readonly string[], root = resolve(import.meta.dir, '../..')): string[] {
  const selects = typecheckSelector(files, root);
  return TYPECHECK_WORKSPACES.filter(([workspace, roots]) => files.some(file => selects(file, workspace, roots)))
    .map(([workspace]) => workspace);
}

function typecheckSelector(files: readonly string[], root: string, graph?: readonly GraphModule[]) {
  const owned = (file: string, root: string) => file.startsWith(root) && TYPECHECK_WORKSPACES.every(([, roots]) =>
    roots.every(other => other.length <= root.length || !file.startsWith(other)));
  const external = files.filter(file => file.startsWith('tests/') && TYPECHECK_SOURCE.test(file));
  const imported = external.length ? scriptsProjectFiles(root, graph) : new Set<string>();
  return (file: string, workspace: string, roots: readonly string[]) => TYPECHECK_SOURCE.test(file)
    && ((workspace === 'scripts' && file.startsWith('tests/') && imported.has(resolve(root, file)))
      || roots.some(root => owned(file, root)));
}

export function planAffected(input: {
  base: string;
  changed: string[];
  graph: GraphModule[];
  sources: Map<string, string>;
  exists: (path: string) => boolean;
  typecheckRoot?: string;
  scriptOnlyManifests?: ReadonlySet<string>;
  /** Dockerfile text. When present, native proofs follow its module-stage COPY inputs. */
  nativeModuleDockerfile?: string;
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
  const referencedBy = referenceIndex(plan.changed, input.sources);
  // Proofs consume their declared module or complete-image COPY set.
  // Stack-tier widening for infra/jena stays in place. An unreadable COPY line
  // fails closed by selecting every registry file, so planning itself still finishes.
  let nativeCopies: readonly NativeModuleCopy[] | undefined;
  let runtimeSources: readonly string[] = [];
  let nativeModuleCopyUnsupported = false;
  if (input.nativeModuleDockerfile !== undefined) {
    try {
      nativeCopies = nativeModuleCopies(input.nativeModuleDockerfile);
      runtimeSources = /^\s*COPY\s/m.test(input.nativeModuleDockerfile)
        ? dockerfileCopySources(input.nativeModuleDockerfile) : [];
    } catch (error) {
      if (!(error instanceof Error) || !/unsupported native module COPY:|JSON-form COPY|Malformed COPY:/.test(error.message)) throw error;
      nativeModuleCopyUnsupported = true;
    }
  }
  const matchedNative = new Set<string>();
  const selectsTypecheck = typecheckSelector(plan.changed, input.typecheckRoot ?? resolve(import.meta.dir, '../..'), input.graph);
  for (const path of plan.changed) {
    if (nativeCopies) for (const file of nativeFilesTouchedBy(path, nativeCopies, runtimeSources)) matchedNative.add(file);
    if (jenaCheckInput.test(path) && !plan.tasks.some(check => check.task === 'jena:check'))
      plan.tasks.push({ task: 'jena:check', because: `${path}: pinned Jena CLI input` });
    for (const [workspace, roots] of TYPECHECK_WORKSPACES) {
      if (!selectsTypecheck(path, workspace, roots)) continue;
      if (!roots.some(root => root.startsWith('scripts/'))) continue;
      const task = `${workspace}:typecheck`;
      if (!plan.tasks.some(check => check.task === task))
        plan.tasks.push({ task, because: `${path}: script type check` });
    }
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
        for (const source of referencedBy(path, true))
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
      for (const source of referencedBy(path, false)) seeds.add(source);
      continue;
    }
    const references = referencedBy(path, true);
    if (!references.length) {
      widen(affectedTiers, `${path}: unclassified input with no code reference`);
      continue;
    }
    for (const source of references) seeds.add(source);
  }
  if (nativeModuleCopyUnsupported) for (const file of inputSelectedNativeTests) matchedNative.add(file);
  for (const file of matchedNative) if (input.exists(file)) seeds.add(file);
  const affected = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const current = queue.pop()!;
    if (affected.has(current)) continue;
    affected.add(current);
    for (const importer of reverse.get(current) ?? [])
      if (!affected.has(importer)) queue.push(importer);
  }
  if (nativeCopies) for (const file of inputSelectedNativeTests) if (!matchedNative.has(file)) affected.delete(file);
  if (input.nativeModuleDockerfile !== undefined) {
    plan.nativeModuleCopySelection = nativeModuleCopyUnsupported
      ? 'unsupported COPY syntax, selected'
      : [...matchedNative].some((file) => input.exists(file)) ? 'selected' : 'not selected';
  }
  // Widened unit and owner tiers use their filtered registry lists. Image proofs
  // stay listed individually when their own COPY rule matched.
  const unitWidened = plan.widened.some((item) => item.tier === 'unit');
  const ownerWidened = plan.widened.some((item) => item.tier === 'owner');
  const guards = selectRepositoryGuards(plan.changed)
    .filter(guard => input.sources.has(guard.file) && input.exists(guard.file));
  const guardFiles = new Set(guards.map(guard => guard.file));
  for (const path of [...affected]
    .filter((path) => testFile.test(path) && input.exists(path))
    .sort()) {
    const route = guardFiles.has(path) ? { tier: 'unit' as const } : routeTest(path);
    if (!route) continue;
    if ('workspace' in route) frontend(route.workspace).tests.push(path);
    else if ('deferred' in route) plan.deferred.push({ file: path, reason: route.deferred });
    else if (
      route.tier === 'unit'
        ? !(unitWidened && inRegisteredUnit(path) && !inputSelectedNative.has(path))
        : route.tier === 'owner'
          ? !(ownerWidened && inRegisteredOwner(path) && !inputSelectedNative.has(path))
          : !plan.widened.some((item) => item.tier === route.tier)
    ) {
      plan.tests[route.tier].push(path);
    }
  }
  // Inventory guards read trees without import edges; use the gate's input rules.
  for (const guard of guards) {
    if (!(unitWidened && inRegisteredUnit(guard.file)) && !plan.tests.unit.includes(guard.file))
      plan.tests.unit.push(guard.file);
  }
  plan.tests.unit.sort();
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

// One analysis holds about 2 GiB for half a minute, and every merge gate and every worker's affected
// plan runs one: four at once left the host 4 GiB on 2026-10-12. Two lanes host-wide; a lane that stays
// busy for a minute is not waited for, so a caller's own deadline is never spent in the queue.
const DEPCRUISE_LANE_BUSY = 75;
function depcruise(root: string, args: string[]): SpawnSyncReturns<string> {
  const program = join(root, 'node_modules/.bin/depcruise');
  const options = { cwd: root, encoding: 'utf8' as const, maxBuffer: 256 * 1024 * 1024 };
  const lane = `/tmp/rezics-depcruise-${process.pid % 2}.lock`;
  const queued = spawnSync('flock', ['-w', '60', '-E', String(DEPCRUISE_LANE_BUSY), lane, program, ...args], options);
  return queued.error || queued.status === DEPCRUISE_LANE_BUSY ? spawnSync(program, args, options) : queued;
}

export function backendGraph(root: string, includeFrontend = false): GraphModule[] {
  const result = depcruise(
    root,
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

function scriptOnlyManifests(root: string, base: string, changed: readonly string[]): Set<string> {
  const result = new Set<string>();
  if (!changed.includes('package.json') || !existsSync(join(root, 'package.json'))) return result;
  const shown = spawnSync('git', ['show', `${base}:package.json`], { cwd: root, encoding: 'utf8' });
  if (shown.status !== 0) return result;
  const withoutScripts = (text: string) => {
    const { scripts: _scripts, ...rest } = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(rest);
  };
  try {
    if (
      withoutScripts(shown.stdout) ===
      withoutScripts(readFileSync(join(root, 'package.json'), 'utf8'))
    ) {
      result.add('package.json');
    }
  } catch {
    // A package.json that does not parse is a dependency change, not a script-only edit.
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

/** Plan one explicit base and changed-file list. Loads script-only manifests, the import graph and Dockerfile inputs. */
export function affectedPlanForChanges(root: string, base: string, changed: readonly string[]): AffectedPlan {
  const files = [...changed];
  const manifests = scriptOnlyManifests(root, base, files);
  const graph = needsGraph(files, manifests)
    ? backendGraph(root, files.some(path => frontendWorkspace(path) !== undefined))
    : [];
  const sources = new Map<string, string>();
  for (const module of graph) {
    const path = join(root, module.source);
    if (codeFile.test(module.source) && existsSync(path))
      sources.set(module.source, readFileSync(path, 'utf8'));
  }
  const dockerfile = join(root, nativeModuleDockerfile);
  return planAffected({
    base,
    changed: files,
    graph,
    sources,
    exists: (path) => existsSync(resolve(root, path)),
    typecheckRoot: root,
    scriptOnlyManifests: manifests,
    nativeModuleDockerfile: existsSync(dockerfile) ? readFileSync(dockerfile, 'utf8') : '',
  });
}

export function affectedPlan(root: string, ref?: string): AffectedPlan {
  const { base, changed } = changedPaths(root, ref);
  return affectedPlanForChanges(root, base, changed);
}

/** People read this. File selection uses the plan object; rewriting these lines does not change the files. */
export function formatPlan(plan: AffectedPlan): string {
  const lines = [`Affected since ${plan.base.slice(0, 12)}: ${plan.changed.length} changed paths`];
  for (const { task, because } of plan.tasks) lines.push(`  task ${task} (${because})`);
  if (plan.nativeModuleCopySelection) lines.push(`  ${nativeModuleCopyInputs}: ${plan.nativeModuleCopySelection}`);
  for (const { tier, because } of plan.widened) {
    // Whole-tier affected commands list their registry files explicitly so image
    // proofs stay out unless one of their own files or COPY inputs changed.
    if (tier === 'unit' || tier === 'owner') {
      lines.push(`  ${tier} tier (${because})`);
      const entries = tier === 'unit' ? affectedUnitTierEntries() : affectedOwnerTierEntries();
      for (const file of entries) lines.push(`  ${tier}: ${file}`);
    } else lines.push(`  ${tier}: whole tier (${because})`);
  }
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
