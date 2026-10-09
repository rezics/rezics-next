import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname, normalize } from 'node:path/posix';

/** Project files Knip may report as unused. Not an entry pattern. */
export const scriptProjectPattern = 'scripts/**/*.ts';

export interface ScriptDiscovery {
  /** Repository-relative glob of files loaded without a static import. */
  pattern: string;
  /** Repository-relative source that performs the scan. One declaration per scan. */
  discoveredBy: string;
}

/** Directory scans Knip cannot see as imports. Each scan is declared once, next to the code that runs it. */
export const scriptDiscoveries: readonly ScriptDiscovery[] = [
  { pattern: 'scripts/**/*.test.ts', discoveredBy: 'scripts/qa/acceptance.ts' },
  { pattern: 'scripts/qa/coverage/*.ts', discoveredBy: 'scripts/qa/coverage.ts' },
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

// Knip skips these workspaces, so a quoted script path here has no import edge.
const hiddenImporters = ['apps/web/', 'packages/ui/'];
const skipped = new Set(['node_modules', 'generated', 'dist', 'coverage', 'target', 'build']);
const scriptToken = String.raw`(?:\.\.?\/|scripts\/)[\w./-]+\.ts`;

function walk(root: string, accept: (name: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (directory: string, relative: string) => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skipped.has(entry.name)) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), next);
      else if (accept(entry.name)) found.push(next);
    }
  };
  visit(root, '');
  return found;
}

function groups(source: string, expression: RegExp): string[] {
  return [...source.matchAll(expression)].map((match) => match[1]!);
}

function resolveScript(fromFile: string, token: string): string | undefined {
  const text = token.replaceAll('\\', '/');
  if (text.startsWith('/') || text.includes('\0')) return undefined;
  const relative = text.startsWith('./') || text.startsWith('../');
  const resolved = normalize(relative ? `${dirname(fromFile)}/${text}` : text);
  return resolved.startsWith('scripts/') && resolved.endsWith('.ts') && !resolved.includes('..')
    ? resolved
    : undefined;
}

/** Launch paths in raw text. A commented-out command can count as an entry. */
function launcherTokens(fromFile: string, source: string): string[] {
  const tokens = groups(
    source,
    new RegExp(String.raw`(?:^|[^\w./-])bun(?:\s+--[\w@][\w@.=/-]*)*\s+(${scriptToken})\b`, 'g'),
  );
  if (fromFile.endsWith('.sh'))
    tokens.push(...groups(source, /(?:\$\{?\w+\}?\/)?(scripts\/[\w./-]+\.ts)\b/g));
  const windows = [...source.matchAll(/['"]bun['"]|\b(?:Bun\.)?spawn(?:Sync)?\s*\(/g)];
  for (const match of windows) {
    const slice = source.slice(match.index ?? 0, (match.index ?? 0) + 800);
    tokens.push(...groups(slice, new RegExp(`['"](${scriptToken})['"]`, 'g')));
    for (const name of groups(slice, /join\(\s*import\.meta\.dir\s*,\s*['"]([^'"]+\.ts)['"]/g))
      tokens.push(normalize(`${dirname(fromFile)}/${name}`));
  }
  return tokens;
}

/** Problems when a discovery is duplicated or its scanner does not name the directory. */
export function discoveryProblems(
  root: string,
  discoveries: readonly ScriptDiscovery[] = scriptDiscoveries,
): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const discovery of discoveries) {
    if (seen.has(discovery.pattern)) problems.push(`duplicate discovery ${discovery.pattern}`);
    seen.add(discovery.pattern);
    if (!existsSync(join(root, discovery.discoveredBy))) {
      problems.push(`missing discoverer ${discovery.discoveredBy}`);
      continue;
    }
    const text = readFileSync(join(root, discovery.discoveredBy), 'utf8');
    const star = discovery.pattern.indexOf('*');
    const anchor = (star < 0 ? discovery.pattern : discovery.pattern.slice(0, star)).replace(
      /\/$/,
      '',
    );
    const leaf = anchor.split('/').filter(Boolean).at(-1) ?? anchor;
    if (!text.includes(anchor) && !text.includes(leaf))
      problems.push(`${discovery.discoveredBy} does not name ${anchor}`);
    if (!/readdir|Bun\.Glob|\.scanSync?\(|\bcruise\s*\(|depcruise/.test(text))
      problems.push(`${discovery.discoveredBy} does not scan a directory`);
  }
  return problems;
}

/** Script files a task, package script, bun/spawn call, or declared scan launches. */
export function scriptEntryFiles(
  root: string,
  discoveries: readonly ScriptDiscovery[] = scriptDiscoveries,
): string[] {
  const found: [string, string][] = [];
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const take = (file: string, tokens: string[]) => {
    for (const token of tokens) found.push([file, token]);
  };
  for (const file of walk(
    root,
    (name) => name === 'Taskfile.yml' || name === 'Taskfile.yaml' || name.endsWith('.sh'),
  ))
    take(file, launcherTokens(file, read(file)));
  for (const file of walk(root, (name) => name === 'package.json')) {
    let scripts: unknown;
    try {
      scripts = (JSON.parse(read(file)) as { scripts?: unknown }).scripts;
    } catch {
      continue;
    }
    if (!scripts || typeof scripts !== 'object') continue;
    for (const command of Object.values(scripts))
      if (typeof command === 'string') take(file, launcherTokens(file, command));
  }
  for (const file of walk(root, (name) => /\.(?:[cm]?tsx?|[cm]?jsx?)$/.test(name))) {
    const source = read(file);
    if (source.includes('bun') || source.includes('spawn'))
      take(file, launcherTokens(file, source));
    if (hiddenImporters.some((directory) => file.startsWith(directory)))
      take(file, groups(source, /['"]((?:\.\.\/)+scripts\/[\w./-]+\.ts)['"]/g));
  }
  const entries = new Set<string>();
  for (const [file, token] of found) {
    const resolved = resolveScript(file, token);
    if (resolved && existsSync(join(root, resolved))) entries.add(resolved);
  }
  for (const discovery of discoveries)
    for (const file of new Bun.Glob(discovery.pattern).scanSync({ cwd: root, onlyFiles: true }))
      if (file.startsWith('scripts/') && file.endsWith('.ts')) entries.add(file);
  return [...entries].sort();
}
