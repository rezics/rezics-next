import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { TYPECHECK_WORKSPACES, type GraphModule } from './affected.ts';

const source = /\.[cm]?tsx?$/;
const configuration = /(?:^|\/)(?:tsconfig[^/]*|package)\.json$|(?:^|\/)yarn\.lock$/;
export interface WorkerTypePlan { workspace: string; project: string; files?: string[] }
export const WORKER_TYPE_PROJECTS = [
  ...TYPECHECK_WORKSPACES.map(([workspace, roots]) => ({ workspace, root: roots[0]!,
    project: `${roots[0]}${workspace === 'apphost' ? 'tsconfig.apphost.json' : 'tsconfig.json'}`, task: `${workspace}:typecheck` })),
  ...['packages/zone-sdk/', 'packages/wiki-toolkit/'].map(root => ({ workspace: root.split('/')[1]!, root,
    project: `${root}tsconfig.json`, task: undefined })),
];

/** Membership and import resolution only: no whole-program ASTs, libraries or type-checker state.
 * The source index may supply the same resolved graph without changing selection. */
export function workerTypePlans(root: string, changed: readonly string[], graph?: readonly GraphModule[]): WorkerTypePlan[] {
  if (!changed.some(file => source.test(file) || configuration.test(file))) return [];
  const ts = createRequire(import.meta.url)('typescript-6') as typeof import('typescript-6');
  const deleted = new Set(changed.filter(file => source.test(file) && !existsSync(join(root, file))).map(file => resolve(root, file)));
  const host = { ...ts.sys, fileExists: (file: string) => deleted.has(resolve(file)) || ts.sys.fileExists(file) };
  const plans: WorkerTypePlan[] = [];
  const scanned = new Map<string, { text: string; refs: ReturnType<typeof ts.preProcessFile> }>();
  for (const { workspace, root: prefix, project } of WORKER_TYPE_PROJECTS) {
    const roots = [prefix];
    const config = join(root, project);
    if (!existsSync(config)) {
      if (changed.some(file => roots.some(prefix => file.startsWith(prefix)))) plans.push({ workspace, project });
      continue;
    }
    const loaded = ts.readConfigFile(config, ts.sys.readFile);
    if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(config));
    if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
    const entries = new Set(parsed.fileNames.map(file => resolve(file)));
    const dependencies = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    const pending = [...entries];
    const supplied = graph && new Map(graph.map(module => [resolve(root, module.source), module]));
    const cache = ts.createModuleResolutionCache(root, file => file, parsed.options);
    const ambient = new Set<string>();
    while (pending.length) {
      const file = resolve(pending.pop()!);
      if (dependencies.has(file) || file.includes('/node_modules/')) continue;
      const targets = new Set<string>();
      dependencies.set(file, targets);
      let facts = scanned.get(file);
      if (!facts) {
        const text = ts.sys.readFile(file);
        if (text === undefined) continue;
        facts = { text, refs: ts.preProcessFile(text, true, /\.[cm]?jsx?$/.test(file)) };
        scanned.set(file, facts);
      }
      const { text, refs } = facts;
      if (/\bdeclare\s+global\b/.test(text)) ambient.add(file);
      const indexed = supplied?.get(file);
      if (indexed) {
        for (const dependency of indexed.dependencies)
          if (!dependency.coreModule) {
            const target = dependency.couldNotResolve
              ? ts.resolveModuleName(dependency.module, file, parsed.options, host, cache).resolvedModule?.resolvedFileName
              : dependency.resolved;
            if (target) targets.add(resolve(root, target));
          }
      } else {
        for (const ref of refs.importedFiles) {
          const target = ts.resolveModuleName(ref.fileName, file, parsed.options, host, cache).resolvedModule;
          if (target) targets.add(resolve(target.resolvedFileName));
        }
      }
      for (const ref of refs.referencedFiles) targets.add(resolve(dirname(file), ref.fileName));
      for (const target of targets) {
        const importers = reverse.get(target) ?? new Set<string>();
        importers.add(file); reverse.set(target, importers); pending.push(target);
      }
    }
    const touched = changed.map(file => resolve(root, file)).filter(file => dependencies.has(file) || reverse.has(file));
    const configChanged = changed.some(file => configuration.test(file) && (!file.includes('/') || roots.some(prefix => file.startsWith(prefix))
      || [...dependencies.keys()].some(dependency => dependency.startsWith(resolve(root, dirname(file)) + '/'))));
    if (!touched.length && !configChanged) continue;
    const affected = new Set(touched);
    const dependents = [...touched];
    while (dependents.length) for (const importer of reverse.get(dependents.pop()!) ?? [])
      if (!affected.has(importer)) { affected.add(importer); dependents.push(importer); }
    const selected = [...affected].filter(file => entries.has(file) && existsSync(file));
    // Ambient declarations apply without an import edge, so preserve them in a narrowed project.
    for (const file of entries) if ((/\.d\.[cm]?ts$/.test(file) || ambient.has(file)) && !selected.includes(file)) selected.push(file);
    const broadDeclaration = touched.some(file => /\.d\.[cm]?ts$/.test(file)
      && (affected.size >= Math.max(1, entries.size / 2) || !ts.isExternalModule(
        ts.createSourceFile(file, scanned.get(file)?.text ?? '', ts.ScriptTarget.Latest, false))));
    plans.push({ workspace, project, ...(!configChanged && workspace !== 'apphost' && !touched.some(file => ambient.has(file)) && !broadDeclaration && selected.length < entries.size
      ? { files: selected.map(file => relative(root, file)).sort() } : {}) });
  }
  return plans;
}

export function workerTypeCommands(root: string, changed: readonly string[], graph?: readonly GraphModule[]): string[][] {
  const indexModule = join(root, 'scripts/lib/repo-index.ts');
  if (!graph && existsSync(indexModule) && changed.some(file => source.test(file) || configuration.test(file))) {
    const { repositoryIndex } = createRequire(import.meta.url)(indexModule) as {
      repositoryIndex: (root: string) => { files: Record<string, { imports: { source: string; resolved?: string | null }[] }> };
    };
    graph = Object.entries(repositoryIndex(root).files).map(([source, facts]) => ({ source,
      dependencies: facts.imports.map(dependency => ({ module: dependency.source, resolved: dependency.resolved ?? '',
        couldNotResolve: !dependency.resolved, coreModule: dependency.source.startsWith('node:') })) }));
  }
  return workerTypePlans(root, changed, graph).filter(plan => plan.files === undefined || plan.files.length).map(plan => plan.files
    ? ['task', 'goal:type-files', '--', '--project', plan.project, ...plan.files]
    : WORKER_TYPE_PROJECTS.find(project => project.workspace === plan.workspace)?.task
      ? ['task', `${plan.workspace}:typecheck`]
      : ['task', 'goal:type-files', '--', '--project', plan.project]);
}
