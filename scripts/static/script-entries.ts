import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalize, dirname } from 'node:path/posix';

/** Project files Knip may report as unused. This is not an entry pattern. */
export const scriptProjectPattern = 'scripts/**/*.ts';

/** Research scripts stay outside the unused-file gate, matching knip.jsonc. */
export const defaultScriptIgnore = ['scripts/research/**'] as const;

export interface ScriptDiscovery {
  /** Repository-relative glob of files loaded without a static import. */
  pattern: string;
  /** Repository-relative source that performs the scan. One declaration per scan. */
  discoveredBy: string;
}

/**
 * Directory scans that load script files Knip cannot see as imports.
 * `acceptance.ts` walks `scripts/` for Bun tests. `coverage.ts` imports every
 * `coverage/*.ts` module except the statically imported declaration. Static
 * fixtures are read or cruised as trees, not imported.
 */
export const scriptDiscoveries: readonly ScriptDiscovery[] = [
  {
    pattern: 'scripts/**/*.test.ts',
    discoveredBy: 'scripts/qa/acceptance.ts',
  },
  {
    pattern: 'scripts/qa/coverage/*.ts',
    discoveredBy: 'scripts/qa/coverage.ts',
  },
  {
    pattern: 'scripts/static/fixtures/mechanism-writers/*.ts',
    discoveredBy: 'scripts/static/mechanism-writers.test.ts',
  },
  {
    pattern: 'scripts/static/fixtures/anti-silo/**/*.ts',
    discoveredBy: 'scripts/static/anti-silo.test.ts',
  },
  {
    pattern: 'scripts/static/fixtures/failing/**/*.ts',
    discoveredBy: 'tests/qa/unit/static-gates.test.ts',
  },
];

/**
 * Knip does not analyze these workspaces, so a script they import has no edge
 * unless it is also an entry.
 */
export const unanalyzedScriptImporters = ['apps/web', 'packages/ui'] as const;

export interface ScriptEntryOptions {
  discoveries?: readonly ScriptDiscovery[];
  ignore?: readonly string[];
  /** Workspaces Knip skips. Scripts they import are still entries. */
  importers?: readonly string[];
}

const skipDirectory = (name: string) =>
  name.startsWith('.') ||
  name === 'node_modules' ||
  name === 'generated' ||
  name === 'dist' ||
  name === 'coverage' ||
  name === 'target' ||
  name === 'build';

const bunPath =
  /(?:^|[^\w./-])bun(?:\s+--[\w@][\w@.=/-]*)*\s+((?:\.\.?\/|scripts\/)[\w./-]+\.ts)\b/g;
const bunArg = /['"]bun['"]/g;
const spawnCall = /\b(?:Bun\.)?spawn(?:Sync)?\s*\(/g;
const spawnedPath = /['"]((?:\.\.?\/|scripts\/)[\w./-]+\.ts)['"]/g;
const spawnedJoin = /join\(\s*import\.meta\.dir\s*,\s*['"]([^'"]+\.ts)['"]\s*\)/g;
const shellScript = /(?:\$\{?\w+\}?\/)?(scripts\/[\w./-]+\.ts)\b/g;
const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function walk(root: string, accept: (name: string) => boolean, start = ''): string[] {
  const found: string[] = [];
  const visit = (directory: string, relative: string) => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipDirectory(entry.name)) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), next);
      else if (accept(entry.name)) found.push(next);
    }
  };
  visit(start ? join(root, start) : root, start);
  return found;
}

function ignored(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(file));
}

function isFile(root: string, file: string): boolean {
  return existsSync(join(root, file));
}

/** Resolve a launcher token to a repository script path, when it is one. */
export function resolveScriptToken(fromFile: string, token: string): string | undefined {
  const text = token.replaceAll('\\', '/');
  if (text.includes('\0') || text.startsWith('/')) return undefined;
  const relative = text.startsWith('./') || text.startsWith('../');
  const resolved = normalize(relative ? `${dirname(fromFile)}/${text}` : text);
  if (!resolved.startsWith('scripts/') || !resolved.endsWith('.ts') || resolved.includes('..'))
    return undefined;
  return resolved;
}

function stripComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "'" || char === '"' || char === '`') {
      const end = skipString(source, index);
      out += source.slice(index, end);
      index = end;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function skipString(source: string, start: number): number {
  const quote = source[start]!;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === "'" || source[index] === '"' || source[index] === '`') {
          index = skipString(source, index);
          continue;
        }
        if (source[index] === '{') depth += 1;
        else if (source[index] === '}') depth -= 1;
        index += 1;
      }
      continue;
    }
    index += 1;
    if (char === quote) return index;
  }
  return index;
}

function tokensFrom(source: string, expression: RegExp): string[] {
  expression.lastIndex = 0;
  return [...source.matchAll(expression)].map((match) => match[1] ?? match[0]);
}

function bunCommandTokens(source: string): string[] {
  const tokens = tokensFrom(source, bunPath);
  bunArg.lastIndex = 0;
  for (const match of source.matchAll(bunArg)) {
    const start = match.index ?? 0;
    tokens.push(...tokensFrom(source.slice(start, start + 1000), spawnedPath));
  }
  return tokens;
}

function commandTokens(fromFile: string, source: string): string[] {
  const tokens = bunCommandTokens(source);
  if (fromFile.endsWith('.sh')) tokens.push(...tokensFrom(source, shellScript));
  return tokens;
}

function spawnTokens(fromFile: string, source: string): string[] {
  const cleaned = stripComments(source);
  const tokens = bunCommandTokens(cleaned);
  spawnCall.lastIndex = 0;
  for (const match of cleaned.matchAll(spawnCall)) {
    const start = match.index ?? 0;
    const window = cleaned.slice(start, start + 1200);
    tokens.push(...tokensFrom(window, spawnedPath));
    for (const joined of tokensFrom(window, spawnedJoin)) {
      tokens.push(normalize(`${dirname(fromFile)}/${joined}`));
    }
  }
  return tokens;
}

function packageScriptTokens(file: string, source: string): string[] {
  let parsed: { scripts?: unknown };
  try {
    parsed = JSON.parse(source) as { scripts?: unknown };
  } catch {
    return [];
  }
  if (!parsed.scripts || typeof parsed.scripts !== 'object') return [];
  const tokens: string[] = [];
  for (const command of Object.values(parsed.scripts)) {
    if (typeof command === 'string') tokens.push(...commandTokens(file, command));
  }
  return tokens;
}

function discoveredFiles(root: string, discoveries: readonly ScriptDiscovery[]): string[] {
  const found: string[] = [];
  for (const discovery of discoveries) {
    found.push(...new Bun.Glob(discovery.pattern).scanSync({ cwd: root, onlyFiles: true }));
  }
  return found;
}

/** Problems when a discovery is duplicated or its scanner is missing. */
export function discoveryProblems(
  root: string,
  discoveries: readonly ScriptDiscovery[] = scriptDiscoveries,
): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const discovery of discoveries) {
    if (seen.has(discovery.pattern)) problems.push(`duplicate discovery ${discovery.pattern}`);
    seen.add(discovery.pattern);
    const source = join(root, discovery.discoveredBy);
    if (!existsSync(source)) {
      problems.push(`missing discoverer ${discovery.discoveredBy}`);
      continue;
    }
    const text = readFileSync(source, 'utf8');
    const star = discovery.pattern.indexOf('*');
    const anchor = (star < 0 ? discovery.pattern : discovery.pattern.slice(0, star)).replace(
      /\/$/,
      '',
    );
    const leaf = anchor.split('/').filter(Boolean).at(-1) ?? anchor;
    if (!text.includes(anchor) && !text.includes(leaf)) {
      problems.push(`${discovery.discoveredBy} does not name ${anchor}`);
    }
    if (!/readdir|Bun\.Glob|\.scanSync?\(|\bcruise\s*\(|depcruise/.test(text)) {
      problems.push(`${discovery.discoveredBy} does not scan a directory`);
    }
  }
  return problems;
}

/** Script files something actually launches, or a declared directory scan loads. */
export function scriptEntryFiles(root: string, options: ScriptEntryOptions = {}): string[] {
  const discoveries = options.discoveries ?? scriptDiscoveries;
  const skip = options.ignore ?? defaultScriptIgnore;
  const tokens: [string, string][] = [];
  for (const file of walk(
    root,
    (name) => name === 'Taskfile.yml' || name === 'Taskfile.yaml' || name.endsWith('.sh'),
  )) {
    tokens.push(
      ...commandTokens(file, readFileSync(join(root, file), 'utf8')).map(
        (token) => [file, token] as [string, string],
      ),
    );
  }
  for (const file of walk(root, (name) => name === 'package.json')) {
    tokens.push(
      ...packageScriptTokens(file, readFileSync(join(root, file), 'utf8')).map(
        (token) => [file, token] as [string, string],
      ),
    );
  }
  for (const file of walk(root, (name) => /\.(?:[cm]?tsx?|[cm]?jsx?)$/.test(name))) {
    const source = readFileSync(join(root, file), 'utf8');
    if (!source.includes('bun') && !source.includes('spawn')) continue;
    tokens.push(...spawnTokens(file, source).map((token) => [file, token] as [string, string]));
  }
  const entries = new Set<string>();
  for (const [file, token] of tokens) {
    const resolved = resolveScriptToken(file, token);
    if (resolved && isFile(root, resolved)) entries.add(resolved);
  }
  for (const file of discoveredFiles(root, discoveries)) {
    if (file.startsWith('scripts/') && file.endsWith('.ts')) entries.add(file);
  }
  for (const importer of options.importers ?? unanalyzedScriptImporters) {
    for (const file of walk(root, (name) => /\.(?:[cm]?tsx?)$/.test(name), importer)) {
      const source = stripComments(readFileSync(join(root, file), 'utf8'));
      if (!source.includes('scripts/')) continue;
      importSpecifier.lastIndex = 0;
      for (const match of source.matchAll(importSpecifier)) {
        const resolved = resolveImport(root, file, match[1]!);
        if (resolved) entries.add(resolved);
      }
    }
  }
  return [...entries].filter((file) => !ignored(file, skip)).sort();
}

function resolveImport(root: string, fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = normalize(`${dirname(fromFile)}/${specifier}`);
  const candidates = specifier.endsWith('.ts')
    ? [base]
    : specifier.endsWith('.js')
      ? [base.replace(/\.js$/, '.ts')]
      : [`${base}.ts`, `${base}/index.ts`];
  return candidates.find((file) => file.startsWith('scripts/') && isFile(root, file));
}

function importedScripts(root: string, file: string): string[] {
  const source = stripComments(readFileSync(join(root, file), 'utf8'));
  importSpecifier.lastIndex = 0;
  const found: string[] = [];
  for (const match of source.matchAll(importSpecifier)) {
    const resolved = resolveImport(root, file, match[1]!);
    if (resolved) found.push(resolved);
  }
  return found;
}

/**
 * Script files that are neither launchers nor reachable by import from one.
 * Ignores follow the Knip ignore list. Imports that enter `scripts/` only from
 * outside it are Knip's to follow; this report is the fixture gate.
 */
export function unusedScriptFiles(root: string, options: ScriptEntryOptions = {}): string[] {
  const skip = options.ignore ?? defaultScriptIgnore;
  const entries = scriptEntryFiles(root, options);
  const reached = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reached.has(file) || !file.startsWith('scripts/') || !isFile(root, file)) continue;
    reached.add(file);
    for (const next of importedScripts(root, file)) {
      if (!reached.has(next)) pending.push(next);
    }
  }
  return [...new Bun.Glob(scriptProjectPattern).scanSync({ cwd: root, onlyFiles: true })]
    .filter((file) => !reached.has(file) && !ignored(file, skip))
    .sort();
}
