import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type Affected = { kind: 'tests'; tests: string[] } | { kind: 'all'; reason: string };

type Package = { directory: string; exports: unknown; main: string | undefined };
type Graph = {
  dependencies: Map<string, Set<string>>;
  opaque: Set<string>;
};

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SQL = /\.sql$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const SOURCE_FOR_COMPILED: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const WHOLE_SUITE_NAMES = /^(?:package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|\.oxlintrc\.json)$/;
const URL_IMPORT = /\bimport\s*\(\s*new\s+URL\(\s*(['"`])([^'"`$\\]+)\1\s*,\s*import\.meta\.url\s*\)(?:\.href)?\s*\)/g;
const DYNAMIC_IMPORT = /\bimport\s*\(/g;
const REQUIRE_CALL = /\brequire\s*\(/g;

function moduleTests(moduleDirectory: string): string[] {
  return Array.from(new Bun.Glob('test/**/*.test.ts').scanSync({ cwd: moduleDirectory })).sort();
}

function isFile(path: string, cache: Map<string, boolean>): boolean {
  let known = cache.get(path);
  if (known === undefined) {
    known = statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
    cache.set(path, known);
  }
  return known;
}

/** Resolve a path the way a bundler would: exact file, a source for a compiled name, an extension, or an index. */
function resolveFile(path: string, cache: Map<string, boolean>): string | null {
  if (isFile(path, cache)) return path;
  const compiled = /\.[cm]?jsx?$/.exec(path)?.[0];
  if (compiled) {
    for (const extension of SOURCE_FOR_COMPILED[compiled] ?? []) {
      const candidate = path.slice(0, -compiled.length) + extension;
      if (isFile(candidate, cache)) return candidate;
    }
  }
  for (const extension of EXTENSIONS) if (isFile(path + extension, cache)) return path + extension;
  for (const extension of EXTENSIONS)
    if (isFile(join(path, `index${extension}`), cache)) return join(path, `index${extension}`);
  return null;
}

function exportTarget(target: unknown): string | null {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const entry of target) {
      const found = exportTarget(entry);
      if (found) return found;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    const conditions = target as Record<string, unknown>;
    for (const condition of ['bun', 'import', 'default', 'types']) {
      const found = exportTarget(conditions[condition]);
      if (found) return found;
    }
  }
  return null;
}

function packageEntry(pkg: Package, subpath: string): string | null {
  const { exports } = pkg;
  if (exports === undefined) {
    if (subpath === '.') return pkg.main ?? 'src/index.ts';
    return subpath;
  }
  const table: Record<string, unknown> =
    typeof exports === 'string' ||
    Array.isArray(exports) ||
    !Object.keys(exports as object).some((key) => key.startsWith('.'))
      ? { '.': exports }
      : (exports as Record<string, unknown>);
  if (subpath in table && !subpath.includes('*')) return exportTarget(table[subpath]);
  let best: { prefix: string; captured: string; target: unknown } | null = null;
  for (const [key, target] of Object.entries(table)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length - 1) continue;
    if (best && best.prefix.length >= prefix.length) continue;
    best = { prefix, captured: subpath.slice(prefix.length, subpath.length - suffix.length), target };
  }
  const found = best ? exportTarget(best.target) : null;
  return found && best ? found.replaceAll('*', best.captured) : null;
}

function workspacePackages(root: string): Map<string, Package> {
  const packages = new Map<string, Package>();
  let patterns: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown };
    if (Array.isArray(manifest.workspaces)) patterns = manifest.workspaces.filter((entry) => typeof entry === 'string');
  } catch {
    return packages;
  }
  for (const pattern of patterns) {
    for (const file of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      try {
        const manifest = JSON.parse(readFileSync(join(root, file), 'utf8')) as {
          name?: unknown;
          exports?: unknown;
          main?: unknown;
        };
        if (typeof manifest.name !== 'string') continue;
        packages.set(manifest.name, {
          directory: join(root, dirname(file)),
          exports: manifest.exports,
          main: typeof manifest.main === 'string' ? manifest.main : undefined,
        });
      } catch {
        // A manifest the scanner cannot read defines no package.
      }
    }
  }
  return packages;
}

function bareName(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/');
  const length = specifier.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, length).join('/');
  return { name, subpath: parts.length > length ? `./${parts.slice(length).join('/')}` : '.' };
}

function loaderFor(path: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (/\.tsx$/.test(path)) return 'tsx';
  if (/\.jsx$/.test(path)) return 'jsx';
  return /\.[cm]?js$/.test(path) ? 'js' : 'ts';
}

function count(pattern: RegExp, text: string): number {
  return text.match(pattern)?.length ?? 0;
}

function buildGraph(root: string, tests: string[]): Graph {
  const packages = workspacePackages(root);
  const files = new Map<string, boolean>();
  const transpilers = new Map<string, Bun.Transpiler>();
  const dependencies = new Map<string, Set<string>>();
  const opaque = new Set<string>();
  const inside = (path: string) => {
    const from = relative(root, path);
    return from !== '' && from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from);
  };

  const resolveSpecifier = (importer: string, specifier: string): string | null => {
    if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return null;
    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      const found = resolveFile(resolve(dirname(importer), specifier), files);
      return found && inside(found) ? found : null;
    }
    const { name, subpath } = bareName(specifier);
    const pkg = packages.get(name);
    if (!pkg) return null;
    const entry = packageEntry(pkg, subpath);
    if (!entry) return null;
    const found = resolveFile(resolve(pkg.directory, entry), files);
    return found && inside(found) ? found : null;
  };

  const queue = tests.map((file) => resolve(root, file));
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index]!;
    if (dependencies.has(file)) continue;
    const reaches = new Set<string>();
    dependencies.set(file, reaches);
    if (!CODE.test(file)) continue;

    const loader = loaderFor(file);
    let transpiler = transpilers.get(loader);
    if (!transpiler) {
      transpiler = new Bun.Transpiler({ loader });
      transpilers.set(loader, transpiler);
    }
    const source = readFileSync(file, 'utf8');
    let specifiers: { kind: string; path: string }[];
    try {
      specifiers = [...transpiler.scanImports(source), ...transpiler.scan(source).imports];
    } catch {
      opaque.add(file);
      continue;
    }

    for (const entry of specifiers) {
      const target = resolveSpecifier(file, entry.path);
      if (target) reaches.add(target);
    }
    // A dynamic import or require whose argument is not a literal is invisible to the scanner.
    let urlImports = 0;
    for (const match of source.matchAll(URL_IMPORT)) {
      urlImports += 1;
      const target = resolveSpecifier(file, match[2]!);
      if (target) reaches.add(target);
    }
    if (
      count(DYNAMIC_IMPORT, source) > literalSites(source, DYNAMIC_IMPORT) + urlImports ||
      count(REQUIRE_CALL, source) > literalSites(source, REQUIRE_CALL)
    ) {
      opaque.add(file);
    }

    for (const target of reaches) queue.push(target);
  }
  return { dependencies, opaque };
}

/** Count call sites whose first argument is a plain string literal. */
function literalSites(source: string, pattern: RegExp): number {
  const literal = new RegExp(`${pattern.source}\\s*(['"\`])[^'"\`$\\\\]*\\1\\s*[,)]`, 'g');
  return count(literal, source);
}

function reverse(dependencies: Map<string, Set<string>>): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const [file, reaches] of dependencies) {
    for (const target of reaches) {
      const list = importers.get(target);
      if (list) list.push(file);
      else importers.set(target, [file]);
    }
  }
  return importers;
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
}

/**
 * Choose the kernel test files that can see a change. `root` is the repository root, `moduleDirectory` the kernel
 * module, and `changed` the changed repository-relative paths.
 */
export function affectedTests(root: string, moduleDirectory: string, changed: string[]): Affected {
  const repository = resolve(root);
  const module = resolve(moduleDirectory);
  const modulePath = normalize(relative(repository, module));
  const forced = [`${modulePath}/test/support/`, `${modulePath}/scripts/`, `${modulePath}/db/`, 'contracts/'];
  // Tests read catalogue, presentation and fixture files at run time, so a data file here may be one no import names.
  const data = [`${modulePath}/`, 'packages/', 'specs/'];

  const tests = moduleTests(module).map((file) => normalize(relative(repository, join(module, file))));
  const paths = changed.map(normalize).filter((path) => path !== '');

  let graph: Graph | null = null;
  let importers: Map<string, string[]> | null = null;
  let participates = false;
  const testSet = new Set(tests);
  const selected = new Set<string>();

  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (WHOLE_SUITE_NAMES.test(name) || forced.some((prefix) => path.startsWith(prefix))) {
      return { kind: 'all', reason: path };
    }
    if (/\.md$/i.test(path)) continue;

    const known = CODE.test(path) || SQL.test(path) || /\.json$/.test(path);
    if (!known) {
      if (data.some((prefix) => path.startsWith(prefix))) return { kind: 'all', reason: path };
      continue;
    }
    if (!graph) {
      graph = buildGraph(repository, tests);
      importers = reverse(graph.dependencies);
    }

    const absolute = resolve(repository, path);
    if (!graph.dependencies.has(absolute)) {
      if ((CODE.test(path) || SQL.test(path)) && !TEST.test(path)) return { kind: 'all', reason: path };
      if (/\.json$/.test(path) && data.some((prefix) => path.startsWith(prefix))) return { kind: 'all', reason: path };
      continue;
    }
    participates = true;
    const pending = [absolute];
    const seen = new Set(pending);
    for (let index = 0; index < pending.length; index += 1) {
      const file = pending[index]!;
      const rel = normalize(relative(repository, file));
      if (testSet.has(rel)) selected.add(rel);
      for (const importer of importers!.get(file) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        pending.push(importer);
      }
    }
  }

  if (participates && graph) {
    const pending = [...graph.opaque];
    const seen = new Set(pending);
    for (let index = 0; index < pending.length; index += 1) {
      const file = pending[index]!;
      const rel = normalize(relative(repository, file));
      if (testSet.has(rel)) selected.add(rel);
      for (const importer of importers!.get(file) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        pending.push(importer);
      }
    }
  }

  return {
    kind: 'tests',
    tests: Array.from(selected)
      .map((path) => normalize(relative(modulePath, path)))
      .sort(),
  };
}
