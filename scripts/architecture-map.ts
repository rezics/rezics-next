// Parser-free part of the architecture tooling: control-plane prompts read the module map without loading
// oxc-parser, which older worktrees may not have installed.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ArchitectureManifest, ArchitectureModule, ModuleKind } from './architecture.ts';

export const MANIFEST_PATH = 'docs/architecture/modules.json';
export const MODULE_MAP_POINTER = 'Other modules: docs/architecture/modules.json';
export const MODULE_MAP_TRUNCATION = '... more modules: read docs/architecture/modules.json';
export const MAX_MODULE_MAP_CHARACTERS = 6_800;

const COMPACT_KIND: Record<ModuleKind, string> = {
  contract: 't',
  core: 'c',
  application: 'a',
  adapter: 'd',
  'composition root': 'r',
  'UI/transport library': 'u',
};

const MODULE_MAP_LEGEND =
  'row module|kind|public entries|allowed dependencies; kind t=contract,c=core,a=app,d=adapter,r=root,u=ui; ' +
  'path k=kernel,w=web,p=package,@=rezics; - = none';

const globCache = new Map<string, RegExp>();

function globRegex(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if ('\\.+?^${}()|[]'.includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  const result = new RegExp(`${source}$`);
  globCache.set(pattern, result);
  return result;
}

function matchesAny(path: string, patterns: string[] | undefined): boolean {
  return (patterns ?? []).some((pattern) => globRegex(pattern).test(path));
}

function compactModuleId(id: string): string {
  return id.replace(/^kernel-/, 'k').replace(/^web-/, 'w');
}

function compactPublicEntry(entry: string): string {
  if (entry.startsWith('@rezics/')) return entry.replace('@rezics/', '@/');
  return entry
    .replace(/^services\/kernel\/src\//, 'k/')
    .replace(/^apps\/web\/src\//, 'w/')
    .replace(/^packages\//, 'p/');
}

function pathPrefix(pattern: string): string {
  return pattern
    .replace(/\/\*\*$/, '')
    .replace(/\/\*$/, '')
    .replace(/\*$/, '')
    .replace(/\/$/, '');
}

function normalizeBriefPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

function prefixesOverlap(briefPrefix: string, modulePrefix: string): boolean {
  return (
    briefPrefix === modulePrefix ||
    briefPrefix.startsWith(`${modulePrefix}/`) ||
    modulePrefix.startsWith(`${briefPrefix}/`)
  );
}

function coveredByExclude(briefPrefix: string, excludes: string[] | undefined): boolean {
  return (excludes ?? []).some((pattern) => {
    const excluded = pathPrefix(pattern);
    return briefPrefix === excluded || briefPrefix.startsWith(`${excluded}/`);
  });
}

function matchesPublicEntry(module: ArchitectureModule, path: string): boolean {
  return module.publicEntries.some((entry) => {
    if (entry === path) return true;
    const compact = compactPublicEntry(entry);
    if (compact === path) return true;
    return globRegex(entry).test(path) || globRegex(compact).test(path);
  });
}

function moduleOwnsPath(module: ArchitectureModule, path: string): boolean {
  if (matchesPublicEntry(module, path)) return true;
  const briefPrefix = pathPrefix(path);
  if (coveredByExclude(briefPrefix, module.excludes)) return false;
  if (matchesAny(path, module.paths)) return true;
  return module.paths.some((pattern) => prefixesOverlap(briefPrefix, pathPrefix(pattern)));
}

function groupPathEntries(entries: readonly string[]): string[] {
  const byDirectory = new Map<string, string[]>();
  const rest: string[] = [];
  for (const entry of entries) {
    const slash = entry.lastIndexOf('/');
    if (slash <= 0) {
      rest.push(entry);
      continue;
    }
    const directory = entry.slice(0, slash);
    const base = entry.slice(slash + 1);
    const grouped = byDirectory.get(directory) ?? [];
    grouped.push(base);
    byDirectory.set(directory, grouped);
  }
  const compact: string[] = [];
  for (const directory of [...byDirectory.keys()].sort()) {
    const bases = byDirectory.get(directory)!.sort();
    compact.push(bases.length === 1 ? `${directory}/${bases[0]!}` : `${directory}:{${bases.join(',')}}`);
  }
  return [...compact, ...rest.sort()];
}

function moduleEntryLabel(module: ArchitectureModule): string {
  const entries = module.publicEntries;
  if (!entries.length) return '-';
  const byPackage = new Map<string, string[]>();
  const other: string[] = [];
  for (const original of entries) {
    const entry = compactPublicEntry(original);
    if (entry.startsWith('@')) {
      const slashAt = entry.indexOf('/');
      const secondSlash = entry.indexOf('/', slashAt + 1);
      const prefix = secondSlash < 0 ? entry : entry.slice(0, secondSlash);
      const suffix = secondSlash < 0 ? '.' : entry.slice(secondSlash + 1);
      const values = byPackage.get(prefix) ?? [];
      values.push(suffix);
      byPackage.set(prefix, values);
    } else {
      other.push(entry);
    }
  }
  const compact = [...byPackage.entries()].map(([prefix, values]) => {
    const sorted = values.sort();
    return sorted.length === 1 && sorted[0] === '.' ? prefix : `${prefix}:{${sorted.join(',')}}`;
  });
  return [...compact, ...groupPathEntries(other)].join(',');
}

function moduleMapRow(module: ArchitectureModule): string {
  const dependencies = module.allowedDependencies.map(compactModuleId).sort().join(',') || '-';
  return [compactModuleId(module.id), COMPACT_KIND[module.kind], moduleEntryLabel(module) || '-', dependencies].join(
    '|',
  );
}

function compareModuleId(left: ArchitectureModule, right: ArchitectureModule): number {
  return left.id.localeCompare(right.id);
}

function renderModuleMap(modules: readonly ArchitectureModule[]): { legend: string; rows: string[]; text: string } {
  const rows = modules.slice().sort(compareModuleId).map(moduleMapRow);
  return { legend: MODULE_MAP_LEGEND, rows, text: [MODULE_MAP_LEGEND, ...rows].join('\n') };
}

function fitRows(legend: string, rows: readonly string[], suffix: string, truncation: string): string {
  const extra = suffix ? `\n${suffix}` : '';
  const omitted = `\n${truncation}`;
  let kept = legend;
  for (const row of rows) {
    if (kept.length + 1 + row.length + omitted.length + extra.length > MAX_MODULE_MAP_CHARACTERS)
      return kept + omitted + extra;
    kept += `\n${row}`;
  }
  return kept + extra;
}

function ownedModulesForBriefPaths(manifest: ArchitectureManifest, paths: readonly string[]): ArchitectureModule[] {
  const owned = new Map<string, ArchitectureModule>();
  for (const raw of paths) {
    const path = normalizeBriefPath(raw);
    if (!path) continue;
    for (const module of manifest.modules) {
      if (moduleOwnsPath(module, path)) owned.set(module.id, module);
    }
  }
  return [...owned.values()].sort(compareModuleId);
}

export function modulesForBriefPaths(manifest: ArchitectureManifest, paths: readonly string[]): ArchitectureModule[] {
  const byId = new Map(manifest.modules.map((module) => [module.id, module]));
  const selected = new Map<string, ArchitectureModule>();
  for (const module of ownedModulesForBriefPaths(manifest, paths)) {
    selected.set(module.id, module);
    for (const dependency of module.allowedDependencies) {
      const resolved = byId.get(dependency);
      if (resolved) selected.set(resolved.id, resolved);
    }
  }
  return [...selected.values()].sort(compareModuleId);
}

export function formatModuleMap(manifest: ArchitectureManifest, paths?: readonly string[]): string {
  if (!paths) {
    const { legend, rows, text } = renderModuleMap(manifest.modules);
    if (text.length <= MAX_MODULE_MAP_CHARACTERS) return text;
    return fitRows(legend, rows, '', MODULE_MAP_TRUNCATION);
  }
  const owned = ownedModulesForBriefPaths(manifest, paths);
  const selected = modulesForBriefPaths(manifest, paths);
  const { legend, text } = renderModuleMap(selected);
  const complete = `${text}\n${MODULE_MAP_POINTER}`;
  if (complete.length <= MAX_MODULE_MAP_CHARACTERS) return complete;
  const ownedIds = new Set(owned.map((module) => module.id));
  const prioritized = [...owned, ...selected.filter((module) => !ownedIds.has(module.id)).sort(compareModuleId)];
  return fitRows(legend, prioritized.map(moduleMapRow), MODULE_MAP_POINTER, MODULE_MAP_TRUNCATION);
}

export function loadManifest(rootInput: string): ArchitectureManifest {
  return JSON.parse(readFileSync(join(resolve(rootInput), MANIFEST_PATH), 'utf8')) as ArchitectureManifest;
}
