// Parser-free part of the architecture tooling: control-plane prompts read the module map without loading
// oxc-parser, which older worktrees may not have installed.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ArchitectureManifest, ArchitectureModule, ModuleKind } from './architecture.ts';

export const MANIFEST_PATH = 'docs/architecture/modules.json';

const COMPACT_KIND: Record<ModuleKind, string> = {
  contract: 't',
  core: 'c',
  application: 'a',
  adapter: 'd',
  'composition root': 'r',
  'UI/transport library': 'u',
};
export const MAX_MODULE_MAP_CHARACTERS = 12_000;

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
  return [...compact, ...other.sort()].join(',');
}

export function formatModuleMap(manifest: ArchitectureManifest): string {
  const legend =
    'row module|kind|public entries|allowed dependencies; kind t=contract,c=core,a=app,d=adapter,r=root,u=ui; ' +
    'path k=kernel,w=web,p=package,@=rezics; - = none';
  const rows = manifest.modules
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((module) => {
      const dependencies = module.allowedDependencies.map(compactModuleId).sort().join(',') || '-';
      return [
        compactModuleId(module.id),
        COMPACT_KIND[module.kind],
        moduleEntryLabel(module) || '-',
        dependencies,
      ].join('|');
    });
  const result = [legend, ...rows].join('\n');
  if (result.length <= MAX_MODULE_MAP_CHARACTERS) return result;
  // Every worker prompt carries this map, so an oversized manifest degrades it rather than failing every start.
  const omitted = '\n... more modules: read docs/architecture/modules.json';
  let kept = legend;
  for (const row of rows) {
    if (kept.length + 1 + row.length + omitted.length > MAX_MODULE_MAP_CHARACTERS) return kept + omitted;
    kept += `\n${row}`;
  }
  return kept;
}

export function loadManifest(rootInput: string): ArchitectureManifest {
  return JSON.parse(readFileSync(join(resolve(rootInput), MANIFEST_PATH), 'utf8')) as ArchitectureManifest;
}
