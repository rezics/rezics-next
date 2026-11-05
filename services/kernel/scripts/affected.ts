import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REACH, type ReachEntry } from './affected-reach.ts';

export type Affected =
  | { kind: 'tests'; tests: { file: string; distance: number | null }[] }
  | { kind: 'all'; reason: string };

type Package = { directory: string; exports: unknown; main: string | undefined };
type Graph = {
  dependencies: Map<string, Set<string>>;
  opaque: Set<string>;
  /** The first reach entry that no longer matches the code, or null. */
  stale: string | null;
};
type Site = { kind: 'import' | 'require'; argument: string };

/** The repository the reach table describes; any other root has no table. */
const REPOSITORY = resolve(import.meta.dir, '../../..');
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
const CALL = /\b(import|require)\s*\(/g;
const LITERAL = /^(['"`])[^'"`$\\]*\1$/;
const URL_ARGUMENT = /^new\s+URL\(\s*(['"`])([^'"`$\\]+)\1\s*,\s*import\.meta\.url\s*\)(?:\.href)?$/;
const OWN_PATH = /\b(?:resolve|join)\(\s*import\.meta\.(?:dir|dirname)((?:\s*,\s*(['"`])[^'"`$\\]*\2)+)\s*\)/g;
const OWN_URL = /\bnew\s+URL\(\s*(['"`])([^'"`$\\]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const IDENTIFIER = /[\w$]/;
const LITERAL_CALL = /\b(?:import|require)\s*\(\s*(['"`])[^'"`$\\]*\1\s*[,)]/g;
const STRING_PART = /(['"`])([^'"`$\\]*)\1/g;
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'throw',
  'new',
  'else',
  'do',
]);

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

/**
 * The source with comments, string contents and template text blanked, positions preserved, so a pattern on it matches
 * only code. Null when the text does not tokenize (JSX text, an unbalanced quote): the caller then keeps the raw text,
 * which can only add sites.
 */
function maskCode(source: string): string | null {
  const length = source.length;
  const out: string[] = [];
  let copied = 0;
  const templates: number[] = [];
  let braces = 0;
  let last = '';
  let word = '';
  const blank = (from: number, to: number) => {
    if (to <= from) return;
    out.push(source.slice(copied, from), source.slice(from, to).replace(/[^\n]/g, ' '));
    copied = to;
  };
  // Scan template text from `from`; returns the index after the closing backtick or `${`, or -1 when unterminated.
  const template = (from: number): number => {
    let at = from;
    while (at < length) {
      const c = source[at];
      if (c === '\\') at += 2;
      else if (c === '`') {
        blank(from, at);
        return at + 1;
      } else if (c === '$' && source[at + 1] === '{') {
        blank(from, at);
        templates.push(braces);
        braces += 1;
        return at + 2;
      } else at += 1;
    }
    return -1;
  };

  let index = 0;
  while (index < length) {
    const c = source[index]!;
    const next = source[index + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const to = end < 0 ? length : end;
      blank(index, to);
      index = to;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return null;
      blank(index, end + 2);
      index = end + 2;
    } else if (c === "'" || c === '"') {
      let at = index + 1;
      while (at < length && source[at] !== c) {
        if (source[at] === '\n') return null;
        at += source[at] === '\\' ? 2 : 1;
      }
      if (at >= length) return null;
      blank(index + 1, at);
      index = at + 1;
      last = c;
      word = '';
    } else if (c === '`') {
      const after = template(index + 1);
      if (after < 0) return null;
      index = after;
      last = '`';
      word = '';
    } else if (c === '{') {
      braces += 1;
      last = c;
      index += 1;
    } else if (c === '}') {
      braces -= 1;
      if (templates.length > 0 && templates[templates.length - 1] === braces) {
        templates.pop();
        const after = template(index + 1);
        if (after < 0) return null;
        index = after;
        last = '`';
      } else {
        last = c;
        index += 1;
      }
      word = '';
    } else if (c === '/' && (last === '' || '(,=:[!&|?{;+-*%<>~^'.includes(last) || REGEX_AFTER_WORD.has(word))) {
      let at = index + 1;
      let inClass = false;
      while (at < length && (source[at] !== '/' || inClass)) {
        const e = source[at];
        if (e === '\n') return null;
        if (e === '\\') at += 1;
        else if (e === '[') inClass = true;
        else if (e === ']') inClass = false;
        at += 1;
      }
      if (at >= length) return null;
      blank(index + 1, at);
      index = at + 1;
      last = '/';
      word = '';
    } else {
      if (c !== ' ' && c !== '\n' && c !== '\t' && c !== '\r') {
        last = c;
        word = IDENTIFIER.test(c) ? (IDENTIFIER.test(source[index - 1] ?? '') ? word + c : c) : '';
      }
      index += 1;
    }
  }
  if (templates.length > 0) return null;
  out.push(source.slice(copied));
  return out.join('');
}

/** The first argument of the call whose opening parenthesis is at `open`, read from the masked text. */
function firstArgument(source: string, masked: string, open: number): string {
  let depth = 0;
  for (let at = open + 1; at < masked.length; at += 1) {
    const c = masked[at];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return source.slice(open + 1, at).trim();
      depth -= 1;
    } else if (c === ',' && depth === 0) return source.slice(open + 1, at).trim();
  }
  return source.slice(open + 1).trim();
}

/**
 * The `import(` and `require(` calls in code position whose argument is not a plain string literal, with the source
 * text of that argument. A literal call is the scanner's, so it is not listed.
 */
function computedSites(source: string): Site[] {
  const raw = source.match(CALL)?.length ?? 0;
  if (raw === 0 || raw === (source.match(LITERAL_CALL)?.length ?? 0)) return [];
  const masked = maskCode(source) ?? source;
  const sites: Site[] = [];
  for (const match of masked.matchAll(CALL)) {
    const argument = firstArgument(source, masked, match.index + match[0].length - 1);
    if (!LITERAL.test(argument)) sites.push({ kind: match[1] as Site['kind'], argument });
  }
  return sites;
}

/** Paths a module builds from its own location and string literals. */
function ownPaths(source: string, directory: string): string[] {
  if (!source.includes('import.meta')) return [];
  const matches = [...source.matchAll(OWN_PATH)];
  const urls = [...source.matchAll(OWN_URL)];
  if (matches.length + urls.length === 0) return [];
  const masked = maskCode(source) ?? source;
  const found: string[] = [];
  for (const match of matches) {
    if (masked[match.index] !== source[match.index]) continue;
    const parts = [...match[1]!.matchAll(STRING_PART)].map((part) => part[2]!);
    found.push(resolve(directory, ...parts));
  }
  for (const match of urls) {
    if (masked[match.index] !== source[match.index]) continue;
    found.push(resolve(directory, match[2]!));
  }
  return found;
}

function buildGraph(root: string, tests: string[], reach: ReachEntry[]): Graph {
  const packages = workspacePackages(root);
  const files = new Map<string, boolean>();
  const transpilers = new Map<string, Bun.Transpiler>();
  const dependencies = new Map<string, Set<string>>();
  const opaque = new Set<string>();
  const entries = new Map<string, ReachEntry[]>();
  for (const entry of reach) {
    const key = resolve(root, entry.module);
    const list = entries.get(key);
    if (list) list.push(entry);
    else entries.set(key, [entry]);
  }
  const expanded = new Map<ReachEntry, string[][]>();
  const expand = (entry: ReachEntry): string[][] => {
    let lists = expanded.get(entry);
    if (!lists) {
      lists = entry.globs.map((glob) =>
        Array.from(new Bun.Glob(glob).scanSync({ cwd: root }))
          .map((file) => resolve(root, file))
          .sort(),
      );
      expanded.set(entry, lists);
    }
    return lists;
  };
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
    const own = entries.get(file) ?? [];
    for (const site of computedSites(source)) {
      const url = URL_ARGUMENT.exec(site.argument);
      if (url) {
        const target = resolveSpecifier(file, url[2]!);
        if (target) reaches.add(target);
        continue;
      }
      const entry = own.find((candidate) => candidate.site === site.argument);
      if (!entry) opaque.add(file);
      else for (const found of expand(entry)) for (const target of found) if (inside(target)) reaches.add(target);
    }
    for (const target of ownPaths(source, dirname(file))) {
      if (inside(target) && isFile(target, files)) reaches.add(target);
    }

    for (const target of reaches) queue.push(target);
  }

  let stale: string | null = null;
  for (const entry of reach) {
    const problem = staleReason(root, entry, expand);
    if (problem) {
      stale = `reach entry ${entry.module} ${entry.site}: ${problem}`;
      break;
    }
  }
  return { dependencies, opaque, stale };
}

/** Why a reach entry no longer describes the code, or null when it still does. */
function staleReason(root: string, entry: ReachEntry, expand: (entry: ReachEntry) => string[][]): string | null {
  const file = resolve(root, entry.module);
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return 'the module is gone';
  }
  if (!computedSites(source).some((site) => site.argument === entry.site)) return 'the import site is gone';
  const lists = expand(entry);
  const dead = lists.findIndex((list) => list.length === 0);
  return dead >= 0 ? `the glob ${entry.globs[dead]} matches no file` : null;
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
 * module, `changed` the changed repository-relative paths, and `reach` what the computed imports can load.
 */
export function affectedTests(
  root: string,
  moduleDirectory: string,
  changed: string[],
  reach?: ReachEntry[],
): Affected {
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
  const changedModules: string[] = [];
  let changedNonTest = false;
  const testSet = new Set(tests);

  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (WHOLE_SUITE_NAMES.test(name) || forced.some((prefix) => path.startsWith(prefix))) {
      return { kind: 'all', reason: path };
    }
    if (/\.md$/i.test(path)) continue;

    const known = CODE.test(path) || SQL.test(path) || /\.json$/.test(path);
    const inData = data.some((prefix) => path.startsWith(prefix));
    if (!known && !inData) continue;
    if (!graph) {
      graph = buildGraph(repository, tests, reach ?? (repository === REPOSITORY ? REACH : []));
      if (graph.stale) return { kind: 'all', reason: graph.stale };
      importers = reverse(graph.dependencies);
    }

    const absolute = resolve(repository, path);
    if (!graph.dependencies.has(absolute)) {
      if ((CODE.test(path) || SQL.test(path)) && !TEST.test(path)) return { kind: 'all', reason: path };
      if (inData && !CODE.test(path) && !SQL.test(path)) return { kind: 'all', reason: path };
      continue;
    }
    changedModules.push(absolute);
    if (!TEST.test(normalize(relative(repository, absolute)))) changedNonTest = true;
  }

  const distances = new Map<string, number | null>();
  if (changedModules.length > 0 && graph) {
    const pending = Array.from(new Set(changedModules));
    const reached = new Map(pending.map((file) => [file, 0]));
    for (let index = 0; index < pending.length; index += 1) {
      const file = pending[index]!;
      const distance = reached.get(file)!;
      const rel = normalize(relative(repository, file));
      if (testSet.has(rel)) distances.set(rel, distance);
      for (const importer of importers!.get(file) ?? []) {
        if (reached.has(importer)) continue;
        reached.set(importer, distance + 1);
        pending.push(importer);
      }
    }
  }

  if (changedNonTest && graph) {
    const pending = [...graph.opaque];
    const seen = new Set(pending);
    for (let index = 0; index < pending.length; index += 1) {
      const file = pending[index]!;
      const rel = normalize(relative(repository, file));
      if (testSet.has(rel) && !distances.has(rel)) distances.set(rel, null);
      for (const importer of importers!.get(file) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        pending.push(importer);
      }
    }
  }

  return {
    kind: 'tests',
    tests: Array.from(distances, ([path, distance]) => ({
      file: normalize(relative(modulePath, path)),
      distance,
    })).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
  };
}
