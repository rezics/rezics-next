import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseSync, visitorKeys, type Node, type Program } from 'oxc-parser';

export type ModuleKind = 'contract' | 'core' | 'application' | 'adapter' | 'composition root' | 'UI/transport library';

export interface SourceRoot {
  path: string;
  extensions: string[];
  exclude?: string[];
}

export interface ArchitectureModule {
  id: string;
  kind: ModuleKind;
  owner: string;
  paths: string[];
  excludes?: string[];
  publicEntries: string[];
  allowedDependencies: string[];
  capabilities: string[];
  postgresPaths?: string[];
}

export interface ArchitectureManifest {
  version: number;
  sourceRoots: SourceRoot[];
  modules: ArchitectureModule[];
}

export interface ImportEdge {
  specifier: string;
  kind: 'value' | 'type';
  ordinal: number;
  line: number;
  column: number;
  targets: string[];
}

export interface ArchitectureGraph {
  version: 1;
  manifestHash: string;
  environmentHash: string;
  hashes: Record<string, string>;
  imports: Record<string, ImportEdge[]>;
  parseErrors: string[];
}

export interface BoundaryViolation {
  rule: string;
  file: string;
  edge: string;
}

export interface BoundaryGroup {
  owner: string;
  reason: string;
  violations: BoundaryViolation[];
}

export interface BoundaryBaseline {
  version: number;
  modules: Record<string, BoundaryGroup>;
}

export interface AuditResult {
  errors: string[];
  warnings: string[];
  violations: BoundaryViolation[];
}

export { MANIFEST_PATH, MAX_MODULE_MAP_CHARACTERS, formatModuleMap, loadManifest } from './architecture-map.ts';
import { MANIFEST_PATH, MAX_MODULE_MAP_CHARACTERS, formatModuleMap, loadManifest } from './architecture-map.ts';
const BASELINE_PATH = 'docs/architecture/boundary-baseline.json';
const CACHE_PATH = '.temp/architecture/graph.json';
const KINDS = new Set<ModuleKind>([
  'contract',
  'core',
  'application',
  'adapter',
  'composition root',
  'UI/transport library',
]);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const EMITTED_SOURCE_EXTENSIONS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts', '.js'],
  '.jsx': ['.tsx', '.ts', '.d.ts', '.jsx'],
  '.mjs': ['.mts', '.d.ts', '.mjs'],
  '.cjs': ['.cts', '.d.ts', '.cjs'],
};
const FORBIDDEN_PACKAGES = new Set(['elysia', 'pg', 'react', 'react-dom']);
const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'stream',
  'timers',
  'url',
  'util',
  'worker_threads',
]);

const pathMappingsCache = new Map<string, { baseUrl: string; paths: Record<string, string[]> }>();
const transpilerCache = new Map<string, Bun.Transpiler>();
const jsonCache = new Map<string, Record<string, unknown> | undefined>();
const globCache = new Map<string, RegExp>();
const fileOverrides = new Map<string, string | null>();

function slash(path: string): string {
  return path.split(sep).join('/');
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function readText(path: string): string {
  const absolute = resolve(path);
  if (fileOverrides.has(absolute)) {
    const value = fileOverrides.get(absolute);
    if (value === null) throw new Error(`File is absent from the captured architecture base: ${absolute}`);
    return value!;
  }
  return readFileSync(absolute, 'utf8');
}

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

function workspaceForPath(path: string): string | undefined {
  const segments = path.split('/');
  if (['apps', 'services', 'packages'].includes(segments[0] ?? '') && segments.length >= 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return undefined;
}

function workspaceRootForFile(root: string, path: string): string {
  const workspace = workspaceForPath(path);
  return workspace ? join(root, workspace) : root;
}

function readJson(path: string): Record<string, unknown> | undefined {
  const absolute = resolve(path);
  if (jsonCache.has(absolute)) return jsonCache.get(absolute);
  try {
    const result = JSON.parse(readText(absolute)) as Record<string, unknown>;
    jsonCache.set(absolute, result);
    return result;
  } catch {
    jsonCache.set(absolute, undefined);
    return undefined;
  }
}

function packageRoots(root: string, manifest: ArchitectureManifest): Map<string, string> {
  const workspaces = new Set<string>();
  for (const sourceRoot of manifest.sourceRoots) {
    const workspace = workspaceForPath(sourceRoot.path);
    if (workspace) workspaces.add(workspace);
  }
  const packages = new Map<string, string>();
  for (const workspace of workspaces) {
    const packagePath = join(root, workspace, 'package.json');
    const value = readJson(packagePath);
    if (typeof value?.name === 'string') packages.set(value.name, join(root, workspace));
  }
  return packages;
}

function packageName(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return undefined;
  }
  const clean = specifier.split(/[?#]/, 1)[0]!;
  const parts = clean.split('/');
  return clean.startsWith('@') ? (parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]) : parts[0];
}

function sourceExtensions(root: SourceRoot): string[] {
  return root.extensions;
}

function isIncludedByRoot(path: string, sourceRoot: SourceRoot): boolean {
  const extensions = sourceExtensions(sourceRoot);
  if (!extensions.some((extension) => path.endsWith(extension))) return false;
  return !matchesAny(path, sourceRoot.exclude);
}

function enumerateProductionFiles(root: string, manifest: ArchitectureManifest): string[] {
  const files: string[] = [];
  for (const sourceRoot of manifest.sourceRoots) {
    const absolute = join(root, sourceRoot.path);
    let info;
    try {
      info = statSync(absolute);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') visit(absolutePath);
        } else if (entry.isFile()) {
          const path = slash(relative(root, absolutePath));
          if (isIncludedByRoot(path, sourceRoot)) files.push(path);
        }
      }
    };
    visit(absolute);
  }
  return [...new Set(files)].sort();
}

function resolveCandidate(root: string, candidate: string, knownFiles: Set<string>): string[] {
  const normalized = slash(relative(root, resolve(root, candidate)));
  const candidates = [normalized];
  const emittedExtension = extname(normalized);
  if (EMITTED_SOURCE_EXTENSIONS[emittedExtension]) {
    const base = normalized.slice(0, -emittedExtension.length);
    for (const extension of EMITTED_SOURCE_EXTENSIONS[emittedExtension]!) candidates.push(`${base}${extension}`);
  }
  if (!extname(normalized)) {
    for (const extension of [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mts',
      '.cts',
      '.mjs',
      '.cjs',
      '.d.ts',
      '.json',
      '.sql',
      '.css',
      '.yaml',
      '.yml',
      '.svg',
    ]) {
      candidates.push(`${normalized}${extension}`);
    }
    for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.json']) candidates.push(`${normalized}/index${extension}`);
  }
  return candidates.filter((path) => knownFiles.has(path));
}

function exportKeys(exportsValue: unknown): Array<[string, unknown]> {
  if (
    typeof exportsValue === 'string' ||
    Array.isArray(exportsValue) ||
    exportsValue === null ||
    typeof exportsValue !== 'object'
  ) {
    return [['.', exportsValue]];
  }
  const entries = Object.entries(exportsValue as Record<string, unknown>);
  return entries.some(([key]) => key.startsWith('.')) ? entries : [['.', exportsValue]];
}

function exportKeyMatches(exportKey: string, subpath: string): { matched: boolean; wildcard?: string } {
  if (exportKey === subpath) return { matched: true };
  const star = exportKey.indexOf('*');
  if (star < 0 || exportKey.indexOf('*', star + 1) >= 0) return { matched: false };
  const prefix = exportKey.slice(0, star);
  const suffix = exportKey.slice(star + 1);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) {
    return { matched: false };
  }
  return { matched: true, wildcard: subpath.slice(prefix.length, subpath.length - suffix.length) };
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  return Object.values(value as Record<string, unknown>).flatMap(exportTargets);
}

function parseJsonc(source: string): string {
  let output = '';
  let quote = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = false;
    } else if (character === '"') {
      quote = true;
      output += character;
    } else if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      if (index < source.length) output += '\n';
    } else if (character === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < source.length) {
        output += '  ';
        index += 1;
      }
    } else {
      output += character;
    }
  }
  return output.replace(/,\s*([}\]])/g, '$1');
}

function readPathMappings(root: string, sourcePath: string): { baseUrl: string; paths: Record<string, string[]> } {
  const configPath = join(workspaceRootForFile(root, sourcePath), 'tsconfig.json');
  const cached = pathMappingsCache.get(configPath);
  if (cached) return cached;
  const visiting = new Set<string>();
  const readConfig = (path: string): { baseUrl: string; paths: Record<string, string[]> } => {
    const absolute = resolve(path);
    if (visiting.has(absolute)) return { baseUrl: dirname(absolute), paths: {} };
    visiting.add(absolute);
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(parseJsonc(readText(absolute))) as Record<string, unknown>;
    } catch {
      visiting.delete(absolute);
      return { baseUrl: dirname(absolute), paths: {} };
    }
    const parentRefs = Array.isArray(config.extends) ? config.extends : config.extends ? [config.extends] : [];
    let parent = { baseUrl: dirname(absolute), paths: {} as Record<string, string[]> };
    for (const reference of parentRefs) {
      if (typeof reference !== 'string' || reference.startsWith('@')) continue;
      let target = resolve(dirname(absolute), reference);
      if (!extname(target)) target += '.json';
      parent = readConfig(target);
    }
    const options =
      config.compilerOptions && typeof config.compilerOptions === 'object'
        ? (config.compilerOptions as Record<string, unknown>)
        : {};
    const baseUrl =
      typeof options.baseUrl === 'string'
        ? resolve(dirname(absolute), options.baseUrl)
        : options.paths
          ? dirname(absolute)
          : parent.baseUrl;
    const paths =
      options.paths && typeof options.paths === 'object' && !Array.isArray(options.paths)
        ? Object.fromEntries(
            Object.entries(options.paths as Record<string, unknown>).flatMap(([key, values]) =>
              Array.isArray(values)
                ? [[key, values.filter((value): value is string => typeof value === 'string')]]
                : [],
            ),
          )
        : parent.paths;
    visiting.delete(absolute);
    return { baseUrl, paths };
  };
  const result = readConfig(configPath);
  pathMappingsCache.set(configPath, result);
  return result;
}

function aliasTargets(root: string, fromPath: string, specifier: string, knownFiles: Set<string>): string[] {
  const { baseUrl, paths } = readPathMappings(root, fromPath);
  const targets = new Set<string>();
  for (const [pattern, replacements] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    let wildcard: string | undefined;
    if (star < 0) {
      if (pattern === specifier) wildcard = '';
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
    if (wildcard === undefined) continue;
    for (const replacement of replacements) {
      const substituted = replacement.replace('*', wildcard);
      for (const target of resolveCandidate(root, join(relative(root, baseUrl), substituted), knownFiles))
        targets.add(target);
    }
  }
  return [...targets].sort();
}

function workspaceExportTargets(
  root: string,
  specifier: string,
  packages: Map<string, string>,
  knownFiles: Set<string>,
): string[] {
  const name = packageName(specifier);
  const workspacePath = name ? packages.get(name) : undefined;
  if (!name || !workspacePath) return [];
  const metadata = readJson(join(workspacePath, 'package.json'));
  if (!metadata) return [];
  const suffix = specifier.slice(name.length);
  const requestedSubpath = suffix ? `.${suffix}` : '.';
  const exportsValue = metadata.exports;
  const results = new Set<string>();
  for (const [key, value] of exportKeys(exportsValue)) {
    const match = exportKeyMatches(key, requestedSubpath);
    if (!match.matched) continue;
    for (const target of exportTargets(value)) {
      if (!target.startsWith('./')) continue;
      const substituted = match.wildcard === undefined ? target : target.replaceAll('*', match.wildcard);
      for (const path of resolveCandidate(root, join(relative(root, workspacePath), substituted), knownFiles))
        results.add(path);
    }
  }
  // Resolve deep workspace paths as well so the boundary check can reject export bypasses.
  if (!results.size && suffix.startsWith('/')) {
    for (const path of resolveCandidate(root, join(relative(root, workspacePath), suffix.slice(1)), knownFiles))
      results.add(path);
  }
  return [...results].sort();
}

function resolveSpecifier(
  root: string,
  fromPath: string,
  specifier: string,
  packages: Map<string, string>,
  knownFiles: Set<string>,
): string[] {
  const exportedTargets = workspaceExportTargets(root, specifier, packages, knownFiles);
  if (exportedTargets.length) return exportedTargets;
  const targets = new Set<string>();
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    for (const path of resolveCandidate(root, join(dirname(fromPath), specifier), knownFiles)) targets.add(path);
  } else {
    for (const path of aliasTargets(root, fromPath, specifier, knownFiles)) targets.add(path);
    const name = packageName(specifier);
    const workspacePath = name ? packages.get(name) : undefined;
    if (workspacePath) {
      const suffix = specifier.slice(name!.length).replace(/^\//, '');
      if (suffix) {
        for (const path of resolveCandidate(root, join(relative(root, workspacePath), suffix), knownFiles))
          targets.add(path);
      }
    }
  }
  return [...targets].sort();
}

function collectImports(source: string, file: string): { imports: ImportEdge[]; errors: string[] } {
  const extension = extname(file);
  if (!CODE_EXTENSIONS.has(extension)) return { imports: [], errors: [] };
  const loader =
    extension === '.tsx' || extension === '.jsx'
      ? 'tsx'
      : extension === '.js' || extension === '.mjs' || extension === '.cjs'
        ? 'js'
        : 'ts';
  let transpiler = transpilerCache.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader });
    transpilerCache.set(loader, transpiler);
  }
  const errors: string[] = [];
  const valueImports = new Map<string, number>();
  let scannerAvailable = true;
  try {
    for (const found of transpiler.scanImports(source)) {
      valueImports.set(found.path, (valueImports.get(found.path) ?? 0) + 1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scannerAvailable = false;
    if (!message.includes('Falling back to classic runtime')) errors.push(`${file}: parser: ${message}`);
  }

  const code = codeCharacterMap(source);
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:(?:[\w$]+)\s*,\s*)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)?\s+from\s*(['"])([^'"]+)\1/g,
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*(['"])([^'"]+)\1/g,
    /\bimport\s*(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];
  const foundAt = new Set<number>();
  const imports: ImportEdge[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (!code[start] || foundAt.has(start)) continue;
      foundAt.add(start);
      const specifier = match[2];
      if (!specifier) continue;
      const explicitType = /^\s*(?:import|export)\s+type\b/.test(match[0]);
      const remaining = valueImports.get(specifier) ?? 0;
      const kind = explicitType ? 'type' : scannerAvailable ? (remaining === 0 ? 'type' : 'value') : 'value';
      if (!explicitType && remaining > 0) valueImports.set(specifier, remaining - 1);
      const position = start + match[0].lastIndexOf(specifier);
      const before = source.slice(0, position);
      imports.push({
        specifier,
        kind,
        line: before.split('\n').length,
        column: position - before.lastIndexOf('\n'),
        ordinal: 0,
        targets: [],
      });
    }
  }
  for (const [specifier, remaining] of valueImports) {
    for (let index = 0; index < remaining; index += 1) {
      const position = source.indexOf(specifier);
      const before = source.slice(0, Math.max(position, 0));
      imports.push({
        specifier,
        kind: 'value',
        line: before.split('\n').length,
        column: Math.max(position, 0) - before.lastIndexOf('\n'),
        ordinal: 0,
        targets: [],
      });
    }
  }
  const occurrences = new Map<string, number>();
  for (const edge of imports) {
    const key = `${edge.kind}\n${edge.specifier}`;
    edge.ordinal = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, edge.ordinal);
  }
  return { imports, errors };
}

function codeCharacterMap(source: string): Uint8Array {
  const code = new Uint8Array(source.length);
  const regexPrefixWords = new Set([
    'await',
    'case',
    'delete',
    'do',
    'else',
    'in',
    'instanceof',
    'new',
    'of',
    'return',
    'throw',
    'typeof',
    'void',
    'yield',
  ]);
  let state: 'code' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment' | 'regex' = 'code';
  let escaped = false;
  let inRegexClass = false;
  let canStartRegex = true;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (character === '/' && next === '/') {
        state = 'line-comment';
        index += 1;
      } else if (character === '/' && next === '*') {
        state = 'block-comment';
        index += 1;
      } else if (character === "'" || character === '"' || character === '`') {
        state = character === "'" ? 'single' : character === '"' ? 'double' : 'template';
        escaped = false;
        canStartRegex = false;
      } else if (character === '/' && canStartRegex) {
        state = 'regex';
        escaped = false;
        inRegexClass = false;
      } else if (/[A-Za-z_$]/.test(character ?? '')) {
        const start = index;
        while (index + 1 < source.length && /[\w$]/.test(source[index + 1]!)) index += 1;
        code.fill(1, start, index + 1);
        canStartRegex = regexPrefixWords.has(source.slice(start, index + 1));
      } else if (/[0-9]/.test(character ?? '')) {
        const start = index;
        while (index + 1 < source.length && /[\w.]/.test(source[index + 1]!)) index += 1;
        code.fill(1, start, index + 1);
        canStartRegex = false;
      } else {
        code[index] = 1;
        if (!/\s/.test(character ?? '')) canStartRegex = ![')', ']', '}', '.'].includes(character ?? '');
      }
    } else if (state === 'line-comment') {
      if (character === '\n') state = 'code';
    } else if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
    } else if (state === 'single' || state === 'double' || state === 'template') {
      const delimiter = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === delimiter) {
        state = 'code';
        canStartRegex = false;
      }
    } else if (state === 'regex') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '[') inRegexClass = true;
      else if (character === ']') inRegexClass = false;
      else if (character === '/' && !inRegexClass) {
        state = 'code';
        canStartRegex = false;
        while (index + 1 < source.length && /[A-Za-z]/.test(source[index + 1]!)) index += 1;
      }
    }
  }
  return code;
}

function environmentHash(root: string, manifest: ArchitectureManifest): string {
  const paths = new Set<string>(['tsconfig.base.json']);
  for (const sourceRoot of manifest.sourceRoots) {
    const workspace = workspaceForPath(sourceRoot.path);
    if (!workspace) continue;
    paths.add(`${workspace}/package.json`);
    paths.add(`${workspace}/tsconfig.json`);
  }
  const values = [...paths].sort().map((path) => {
    try {
      return [path, sha256(readText(join(root, path)))];
    } catch {
      return [path, 'missing'];
    }
  });
  return sha256(canonical(values));
}

export function buildGraph(rootInput: string, manifest: ArchitectureManifest): ArchitectureGraph {
  const root = resolve(rootInput);
  pathMappingsCache.clear();
  jsonCache.clear();
  const files = enumerateProductionFiles(root, manifest);
  const knownFiles = new Set(files);
  const packages = packageRoots(root, manifest);
  const hashes: Record<string, string> = {};
  const imports: Record<string, ImportEdge[]> = {};
  const parseErrors: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file));
    hashes[file] = sha256(source);
    const parsed = collectImports(source.toString('utf8'), file);
    parseErrors.push(...parsed.errors);
    imports[file] = parsed.imports.map((edge) => ({
      ...edge,
      targets: resolveSpecifier(root, file, edge.specifier, packages, knownFiles),
    }));
  }
  return {
    version: 1,
    manifestHash: sha256(canonical(manifest)),
    environmentHash: environmentHash(root, manifest),
    hashes,
    imports,
    parseErrors,
  };
}

function cachePath(root: string): string {
  return join(root, CACHE_PATH);
}

export function writeGraphCache(rootInput: string, graph: ArchitectureGraph): void {
  const root = resolve(rootInput);
  const path = cachePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(graph)}\n`);
}

function readGraphCache(root: string): ArchitectureGraph | undefined {
  try {
    return JSON.parse(readFileSync(cachePath(root), 'utf8')) as ArchitectureGraph;
  } catch {
    return undefined;
  }
}

export function changedGraph(
  rootInput: string,
  manifest: ArchitectureManifest,
  changedFiles: string[],
): ArchitectureGraph {
  const root = resolve(rootInput);
  const cached = readGraphCache(root);
  if (!cached) throw new Error('No complete architecture graph cache; run bun scripts/architecture.ts first.');
  const expectedManifestHash = sha256(canonical(manifest));
  const expectedEnvironmentHash = environmentHash(root, manifest);
  if (cached.manifestHash !== expectedManifestHash || cached.environmentHash !== expectedEnvironmentHash) {
    throw new Error('Architecture manifest or workspace resolution changed; run bun scripts/architecture.ts first.');
  }

  const files = enumerateProductionFiles(root, manifest);
  const fileSet = new Set(files);
  pathMappingsCache.clear();
  jsonCache.clear();
  const normalizedChanged = new Set(changedFiles.map((file) => slash(relative(root, resolve(root, file)))));
  const hashes: Record<string, string> = {};
  const actualChanged = new Set<string>();
  for (const file of files) {
    const hash = sha256(readFileSync(join(root, file)));
    hashes[file] = hash;
    if (cached.hashes[file] !== hash) actualChanged.add(file);
  }
  for (const file of Object.keys(cached.hashes)) {
    if (!fileSet.has(file)) actualChanged.add(file);
  }
  const omissions = [...actualChanged].filter((file) => !normalizedChanged.has(file));
  if (omissions.length) {
    throw new Error(`--changed omitted modified source files: ${omissions.sort().join(', ')}`);
  }

  const structureChanged =
    Object.keys(cached.hashes).some((file) => !fileSet.has(file)) || files.some((file) => !(file in cached.hashes));
  const packages = packageRoots(root, manifest);
  const knownFiles = new Set(files);
  const imports: Record<string, ImportEdge[]> = {};
  const parseErrors: string[] = [];
  for (const file of files) {
    if (!actualChanged.has(file)) {
      const previous = cached.imports[file] ?? [];
      imports[file] = structureChanged
        ? previous.map((edge) => ({
            ...edge,
            targets: resolveSpecifier(root, file, edge.specifier, packages, knownFiles),
          }))
        : previous;
      continue;
    }
    const parsed = collectImports(readFileSync(join(root, file), 'utf8'), file);
    parseErrors.push(...parsed.errors);
    imports[file] = parsed.imports.map((edge) => ({
      ...edge,
      targets: resolveSpecifier(root, file, edge.specifier, packages, knownFiles),
    }));
  }
  const graph: ArchitectureGraph = {
    version: 1,
    manifestHash: cached.manifestHash,
    environmentHash: cached.environmentHash,
    hashes,
    imports,
    parseErrors: [
      ...cached.parseErrors.filter((error) => ![...actualChanged].some((file) => error.startsWith(`${file}:`))),
      ...parseErrors,
    ],
  };
  writeGraphCache(root, graph);
  return graph;
}

/** A repository binding evaluated while importing a file, rather than when using it. */
export interface LoadTimeRead {
  file: string;
  initializer: string;
  binding: string;
  specifier: string;
  line: number;
  column: number;
}

function syntaxChildren(node: Node): Node[] {
  const fields = node as unknown as Record<string, unknown>;
  return (visitorKeys[node.type] ?? [])
    .filter((key) => !['typeAnnotation', 'typeArguments', 'typeParameters', 'returnType', 'implements'].includes(key))
    .flatMap((key) => {
      const value = fields[key];
      return (Array.isArray(value) ? value.filter(Boolean) : value ? [value] : []) as Node[];
    });
}

function runtimeExpression(node: Node): Node {
  switch (node.type) {
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
    case 'ParenthesizedExpression':
      return runtimeExpression(node.expression);
    default:
      return node;
  }
}

function declarationNode(node: Node): Node | null {
  if (node.type === 'ExportNamedDeclaration') return node.declaration;
  if (node.type === 'ExportDefaultDeclaration') return node.declaration;
  return node;
}

/** Literal leaves contain data only: no runtime imports, functions, getters or constructor calls. */
function literalLeaf(program: Program): boolean {
  const literal = (input: Node): boolean => {
    const node = runtimeExpression(input);
    switch (node.type) {
      case 'Literal':
        return true;
      case 'UnaryExpression':
        return literal(node.argument);
      case 'BinaryExpression':
        return literal(node.left) && literal(node.right);
      case 'ArrayExpression':
        return node.elements.every((item) => item === null || literal(item));
      case 'ObjectExpression':
        return node.properties.every(
          (property) =>
            property.type === 'Property' &&
            !property.computed &&
            property.kind === 'init' &&
            !property.method &&
            literal(property.value),
        );
      // Freezing a literal does not introduce a dependency on another module's initialization.
      case 'CallExpression':
        return (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'Object' &&
          !node.callee.computed &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'freeze' &&
          node.arguments.length === 1 &&
          literal(node.arguments[0]!)
        );
      default:
        return false;
    }
  };
  return program.body.every((statement) => {
    if (statement.type === 'ImportDeclaration')
      return (
        statement.importKind === 'type' ||
        (statement.specifiers.length > 0 &&
          statement.specifiers.every((item) => item.type === 'ImportSpecifier' && item.importKind === 'type'))
      );
    if (statement.type === 'ExportNamedDeclaration' && statement.source) return statement.exportKind === 'type';
    const node = declarationNode(statement);
    if (!node) return true;
    if (node.type === 'VariableDeclaration')
      return node.kind === 'const' && node.declarations.every((item) => item.init !== null && literal(item.init));
    if (statement.type === 'ExportDefaultDeclaration') return literal(node);
    return (
      node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration' || node.type === 'EmptyStatement'
    );
  });
}

/**
 * Inspect executable syntax without importing production code. Function bodies and instance fields
 * are deferred; local functions invoked by an initializer and class static initializers are eager.
 * External packages are outside the repository graph; workspace packages are resolved normally.
 */
export function findLoadTimeReads(
  root: string,
  graph: ArchitectureGraph,
  sourceFiles: readonly string[] = Object.keys(graph.hashes),
): LoadTimeRead[] {
  const programs = new Map<string, Program>();
  const leaves = new Set<string>();
  const relevantFiles = new Set(sourceFiles);
  for (const source of sourceFiles)
    for (const edge of graph.imports[source] ?? []) for (const target of edge.targets) relevantFiles.add(target);
  for (const file of relevantFiles) {
    if (extname(file) === '.json') leaves.add(file);
    if (!CODE_EXTENSIONS.has(extname(file)) || file.endsWith('.d.ts')) continue;
    const parsed = parseSync(file, readFileSync(join(root, file), 'utf8'));
    if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0]!.message}`);
    programs.set(file, parsed.program);
    if (literalLeaf(parsed.program)) leaves.add(file);
  }
  const reads: LoadTimeRead[] = [];
  for (const file of sourceFiles) {
    const program = programs.get(file);
    if (!program) continue;
    const imports = new Map<string, string>();
    const functions = new Map<string, Node>();
    const values = new Map<string, Node>();
    for (const statement of program.body) {
      if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type') {
        const specifier = String(statement.source.value);
        const targets = graph.imports[file]?.find((edge) => edge.specifier === specifier)?.targets ?? [];
        if (targets.length === 0 || targets.every((target) => leaves.has(target))) continue;
        for (const binding of statement.specifiers) {
          if (binding.type !== 'ImportSpecifier' || binding.importKind !== 'type')
            imports.set(binding.local.name, specifier);
        }
      }
      const node = declarationNode(statement);
      if (node?.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, node);
      if (node?.type === 'VariableDeclaration') {
        for (const item of node.declarations) {
          if (item.id.type === 'Identifier' && item.init) {
            const init = runtimeExpression(item.init);
            values.set(item.id.name, init);
            if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
              functions.set(item.id.name, init);
          }
        }
      }
    }
    if (imports.size === 0) continue;
    const source = readFileSync(join(root, file), 'utf8');
    const seen = new Set<string>();
    const activeCalls = new Set<Node>();
    const activeValues = new Set<Node>();
    const callScopes: { bindings: Set<string>; functions: Map<string, Node> }[] = [];
    const calledFunction = (name: string, shadowed: Set<string>): Node | undefined => {
      for (let index = callScopes.length - 1; index >= 0; index--) {
        const scope = callScopes[index]!;
        if (scope.bindings.has(name)) return scope.functions.get(name);
      }
      return shadowed.has(name) ? undefined : functions.get(name);
    };
    let initializer = '';
    const report = (node: Node & { name: string }): void => {
      const specifier = imports.get(node.name);
      if (!specifier) return;
      const key = `${initializer}:${node.start}`;
      if (seen.has(key)) return;
      seen.add(key);
      const before = source.slice(0, node.start);
      reads.push({
        file,
        initializer,
        binding: node.name,
        specifier,
        line: before.split('\n').length,
        column: node.start - before.lastIndexOf('\n'),
      });
    };
    const bindNames = (node: Node, names: Set<string>): void => {
      if (node.type === 'Identifier') names.add(node.name);
      else if (node.type === 'AssignmentPattern') bindNames(node.left, names);
      else if (node.type === 'Property') bindNames(node.value, names);
      else for (const child of syntaxChildren(node)) bindNames(child, names);
    };
    const invoke = (node: Node, shadowed: Set<string>): void => {
      if (activeCalls.has(node)) return;
      activeCalls.add(node);
      const local = new Set(shadowed);
      if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression'
      ) {
        const bindings = new Set<string>();
        for (const parameter of node.params) bindNames(parameter, bindings);
        const localFunctions = new Map<string, Node>();
        const collectLocals = (child: Node): void => {
          if (child.type === 'FunctionDeclaration') {
            if (child.id) {
              bindings.add(child.id.name);
              localFunctions.set(child.id.name, child);
            }
            return;
          }
          if (child.type === 'FunctionExpression' || child.type === 'ArrowFunctionExpression') return;
          if (child.type === 'VariableDeclarator') {
            bindNames(child.id, bindings);
            if (child.id.type === 'Identifier' && child.init) {
              const value = runtimeExpression(child.init);
              if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
                localFunctions.set(child.id.name, value);
            }
          }
          for (const next of syntaxChildren(child)) collectLocals(next);
        };
        if (node.body) collectLocals(node.body);
        for (const name of bindings) local.add(name);
        callScopes.push({ bindings, functions: localFunctions });
        for (const parameter of node.params) walk(parameter, local);
        if (node.body) walk(node.body, local);
        callScopes.pop();
      }
      activeCalls.delete(node);
    };
    const walk = (input: Node, shadowed = new Set<string>()): void => {
      const node = runtimeExpression(input);
      switch (node.type) {
        case 'Identifier':
          if (!shadowed.has(node.name)) {
            report(node);
            const value = values.get(node.name);
            if (value && !activeValues.has(value)) {
              activeValues.add(value);
              walk(value, shadowed);
              activeValues.delete(value);
            }
          }
          return;
        case 'ImportDeclaration':
        case 'ExportAllDeclaration':
        case 'ExportSpecifier':
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
          return;
        case 'ExportNamedDeclaration':
          if (node.declaration) walk(node.declaration, shadowed);
          return;
        case 'MemberExpression':
          walk(node.object, shadowed);
          if (node.computed) walk(node.property, shadowed);
          return;
        case 'Property':
          if (node.computed) walk(node.key, shadowed);
          if (node.kind === 'init') walk(node.value, shadowed);
          return;
        case 'MethodDefinition':
          if (node.computed) walk(node.key, shadowed);
          return;
        case 'PropertyDefinition':
        case 'AccessorProperty':
          if (node.computed) walk(node.key, shadowed);
          if (node.static && node.value) walk(node.value, shadowed);
          return;
        case 'VariableDeclarator':
          if (node.init) walk(node.init, shadowed);
          if (node.id.type !== 'Identifier') walk(node.id, shadowed);
          return;
        case 'ClassDeclaration':
        case 'ClassExpression':
          if (node.superClass) walk(node.superClass, shadowed);
          for (const decorator of node.decorators) walk(decorator, shadowed);
          walk(node.body, shadowed);
          return;
        case 'CallExpression':
        case 'NewExpression': {
          walk(node.callee, shadowed);
          for (const argument of node.arguments) walk(argument, shadowed);
          if (
            node.type === 'CallExpression' &&
            node.callee.type === 'MemberExpression' &&
            !node.callee.computed &&
            node.callee.property.type === 'Identifier' &&
            [
              'map',
              'flatMap',
              'filter',
              'reduce',
              'reduceRight',
              'forEach',
              'some',
              'every',
              'find',
              'findIndex',
              'sort',
              'from',
            ].includes(node.callee.property.name)
          ) {
            for (const argument of node.arguments) {
              const callback = runtimeExpression(argument);
              if (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression')
                invoke(callback, shadowed);
              else if (callback.type === 'Identifier') {
                const fn = calledFunction(callback.name, shadowed);
                if (fn) invoke(fn, shadowed);
              }
            }
          }
          const callee = runtimeExpression(node.callee);
          if (callee.type === 'Identifier') {
            const fn = calledFunction(callee.name, shadowed);
            if (fn) invoke(fn, shadowed);
          } else if (callee.type === 'FunctionExpression' || callee.type === 'ArrowFunctionExpression') {
            invoke(callee, shadowed);
          }
          return;
        }
        case 'IfStatement':
          // A process entry point is invoked explicitly, and is never run by importing the module.
          if (source.slice(node.test.start, node.test.end) === 'import.meta.main') return;
          break;
      }
      if (
        node.type.startsWith('TS') &&
        node.type !== 'TSEnumDeclaration' &&
        node.type !== 'TSEnumMember' &&
        node.type !== 'TSModuleDeclaration' &&
        node.type !== 'TSModuleBlock' &&
        node.type !== 'TSParameterProperty'
      )
        return;
      for (const child of syntaxChildren(node)) walk(child, shadowed);
    };
    for (const statement of program.body) {
      const node = declarationNode(statement);
      if (node?.type === 'VariableDeclaration') {
        for (const item of node.declarations) {
          initializer = source.slice(item.id.start, item.id.end);
          walk(item);
        }
      } else {
        initializer = node?.type ?? statement.type;
        walk(statement);
      }
    }
  }
  return reads;
}

function moduleForFile(path: string, manifest: ArchitectureManifest): ArchitectureModule[] {
  return manifest.modules.filter((module) => matchesAny(path, module.paths) && !matchesAny(path, module.excludes));
}

export function moduleIdForFile(path: string, manifest: ArchitectureManifest): string | undefined {
  return moduleForFile(path, manifest)[0]?.id;
}

function moduleRank(kind: ModuleKind): number {
  switch (kind) {
    case 'contract':
      return 0;
    case 'core':
      return 1;
    case 'application':
      return 2;
    case 'adapter':
    case 'UI/transport library':
      return 3;
    case 'composition root':
      return 4;
  }
}

export function validateManifest(manifest: ArchitectureManifest): string[] {
  const errors: string[] = [];
  if (manifest.version !== 1) errors.push(`manifest version must be 1 (received ${manifest.version})`);
  if (!Array.isArray(manifest.sourceRoots) || !Array.isArray(manifest.modules))
    return [...errors, 'manifest sourceRoots and modules must be arrays'];
  const ids = new Set<string>();
  const capabilities = new Map<string, string>();
  for (const module of manifest.modules) {
    if (!module.id || ids.has(module.id)) errors.push(`duplicate or empty module id: ${module.id || '<empty>'}`);
    ids.add(module.id);
    if (!KINDS.has(module.kind)) errors.push(`${module.id}: unsupported kind ${String(module.kind)}`);
    if (!module.owner?.trim()) errors.push(`${module.id}: owner Goal is required`);
    if (!Array.isArray(module.paths) || module.paths.length === 0)
      errors.push(`${module.id}: at least one path is required`);
    if (
      !Array.isArray(module.publicEntries) ||
      !Array.isArray(module.allowedDependencies) ||
      !Array.isArray(module.capabilities)
    ) {
      errors.push(`${module.id}: publicEntries, allowedDependencies, and capabilities must be arrays`);
    }
    for (const capability of module.capabilities ?? []) {
      const owner = capabilities.get(capability);
      if (owner && owner !== module.owner)
        errors.push(`${module.id}: capability ${capability} is also owned by ${owner}`);
      capabilities.set(capability, module.owner);
    }
  }
  for (const module of manifest.modules) {
    for (const dependency of module.allowedDependencies ?? []) {
      if (dependency !== '*' && !ids.has(dependency))
        errors.push(`${module.id}: unknown allowed dependency ${dependency}`);
    }
    if ((module.allowedDependencies ?? []).includes(module.id))
      errors.push(`${module.id}: a module cannot allow itself as a dependency`);
  }
  for (const sourceRoot of manifest.sourceRoots) {
    if (!sourceRoot.path || !Array.isArray(sourceRoot.extensions) || sourceRoot.extensions.length === 0) {
      errors.push(`source root ${sourceRoot.path || '<empty>'}: path and extensions are required`);
    }
  }
  return errors;
}

function baselineKey(violation: BoundaryViolation): string {
  return `${violation.rule}\n${violation.file}\n${violation.edge}`;
}

export function validateBaseline(baseline: BoundaryBaseline): string[] {
  const errors: string[] = [];
  if (baseline.version !== 1) errors.push(`baseline version must be 1 (received ${baseline.version})`);
  if (!baseline.modules || typeof baseline.modules !== 'object' || Array.isArray(baseline.modules)) {
    return [...errors, 'baseline modules must be grouped by module'];
  }
  const seen = new Set<string>();
  for (const [moduleId, group] of Object.entries(baseline.modules)) {
    if (!group || typeof group !== 'object') {
      errors.push(`rule 8: baseline module ${moduleId} must have an owner, reason, and violations`);
      continue;
    }
    for (const violation of group.violations ?? []) {
      const detail = `${violation.file || '<missing file>'}: ${violation.edge || '<missing edge>'}`;
      if (!group.owner?.trim() || !group.reason?.trim()) {
        errors.push(`rule 8: ${detail}: baseline module ${moduleId} requires an owner and reason`);
      }
      if (!violation.rule || !violation.file || !violation.edge) {
        errors.push(`rule 8: ${detail}: baseline entries require rule, file, and edge`);
      }
      const key = `${moduleId}\n${baselineKey(violation)}`;
      if (seen.has(key)) errors.push(`rule 8: ${detail}: duplicate baseline entry for ${moduleId}`);
      seen.add(key);
    }
  }
  return errors;
}

function stableEdge(edge: ImportEdge, target: string): string {
  return `${edge.kind} import ${JSON.stringify(edge.specifier)} #${edge.ordinal} => ${target}`;
}

function packageExportTargetMap(root: string, manifest: ArchitectureManifest): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const sourceRoot of manifest.sourceRoots) {
    const workspace = workspaceForPath(sourceRoot.path);
    if (!workspace) continue;
    const metadata = readJson(join(root, workspace, 'package.json'));
    if (!metadata || typeof metadata.name !== 'string') continue;
    for (const [key, value] of exportKeys(metadata.exports)) {
      const publicEntry = key === '.' ? metadata.name : `${metadata.name}${key.slice(1)}`;
      for (const target of exportTargets(value)) {
        if (!target.startsWith('./')) continue;
        const wildcard = key.indexOf('*');
        const starTarget = target.indexOf('*');
        if (wildcard >= 0 && starTarget >= 0) continue;
        const path = slash(relative(root, resolve(root, workspace, target)));
        const entries = targets.get(path) ?? new Set<string>();
        entries.add(publicEntry);
        targets.set(path, entries);
      }
    }
  }
  return targets;
}

function matchesEntry(specifier: string, entries: string[]): boolean {
  return entries.some((entry) => globRegex(entry).test(specifier));
}

function isPublicTarget(
  specifier: string,
  target: string,
  targetModule: ArchitectureModule,
  exportTargets: Map<string, Set<string>>,
): boolean {
  if (matchesEntry(specifier, targetModule.publicEntries)) return true;
  if (targetModule.publicEntries.includes(target)) return true;
  const exports = exportTargets.get(slash(target));
  return exports ? [...exports].some((entry) => matchesEntry(entry, targetModule.publicEntries)) : false;
}

function forbiddenRuntimeImport(specifier: string): boolean {
  const name = packageName(specifier);
  const normalized = (name ?? specifier).replace(/^node:/, '');
  return (
    specifier === 'bun' ||
    specifier.startsWith('bun:') ||
    specifier.startsWith('node:') ||
    NODE_BUILTINS.has(normalized) ||
    NODE_BUILTINS.has(normalized.replace(/^node:/, ''))
  );
}

function forbiddenEffectImport(specifier: string, target: string | undefined): boolean {
  const name = packageName(specifier);
  return (
    (name !== undefined && (FORBIDDEN_PACKAGES.has(name) || name.toLowerCase().includes('dbos'))) ||
    forbiddenRuntimeImport(specifier) ||
    specifier.endsWith('.sql') ||
    Boolean(target?.endsWith('.sql'))
  );
}

interface LocatedEdge {
  source: string;
  sourceModule: ArchitectureModule;
  edge: ImportEdge;
  target: string;
  targetModule: ArchitectureModule;
}

function stronglyConnectedComponents(nodes: string[], edges: Array<[string, string]>): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const [source, target] of edges) adjacency.get(source)?.push(target);
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component);
  };
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return components;
}

function baselineLookup(baseline: BoundaryBaseline): Map<string, BoundaryViolation> {
  const lookup = new Map<string, BoundaryViolation>();
  for (const [moduleId, group] of Object.entries(baseline.modules)) {
    for (const violation of group.violations ?? []) lookup.set(`${moduleId}\n${baselineKey(violation)}`, violation);
  }
  return lookup;
}

export function createBoundaryBaseline(
  modules: ArchitectureModule[],
  grouped: Map<string, BoundaryViolation[]>,
): BoundaryBaseline {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const result: BoundaryBaseline = { version: 1, modules: {} };
  for (const [moduleId, violations] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const module = byId.get(moduleId);
    if (!module || violations.length === 0) continue;
    const unique = new Map(violations.map((violation) => [baselineKey(violation), violation]));
    result.modules[moduleId] = {
      owner: module.owner,
      reason: 'pre-boundary code',
      violations: [...unique.values()].sort((left, right) => baselineKey(left).localeCompare(baselineKey(right))),
    };
  }
  return result;
}

export function dependenciesFromGraph(
  manifest: ArchitectureManifest,
  graph: ArchitectureGraph,
): Record<string, string[]> {
  const dependencies = new Map(manifest.modules.map((module) => [module.id, new Set<string>()]));
  for (const [source, imports] of Object.entries(graph.imports)) {
    const sourceModule = moduleForFile(source, manifest)[0];
    if (!sourceModule) continue;
    for (const edge of imports) {
      for (const target of edge.targets) {
        const targetModule = moduleForFile(target, manifest)[0];
        if (targetModule && targetModule.id !== sourceModule.id)
          dependencies.get(sourceModule.id)?.add(targetModule.id);
      }
    }
  }
  return Object.fromEntries([...dependencies.entries()].map(([id, values]) => [id, [...values].sort()]));
}

export function auditArchitecture(
  rootInput: string,
  manifest: ArchitectureManifest,
  baseline: BoundaryBaseline,
  graph: ArchitectureGraph,
): AuditResult {
  const root = resolve(rootInput);
  const errors = validateManifest(manifest);
  const warnings: string[] = [];
  const violations: BoundaryViolation[] = [];
  const currentByModule = new Map<string, Map<string, BoundaryViolation>>();
  const diagnosticContexts = new Map<string, string>();
  const add = (moduleId: string, rule: string, file: string, edge: string, context?: string): void => {
    const violation = { rule, file, edge };
    const key = `${moduleId}\n${baselineKey(violation)}`;
    const group = currentByModule.get(moduleId) ?? new Map<string, BoundaryViolation>();
    group.set(baselineKey(violation), violation);
    currentByModule.set(moduleId, group);
    if (context) diagnosticContexts.set(key, context);
  };

  const files = Object.keys(graph.hashes).sort();
  const ownerByFile = new Map<string, ArchitectureModule>();
  for (const file of files) {
    const owners = moduleForFile(file, manifest);
    if (owners.length === 0) {
      errors.push(`rule 1: ${file}: production file belongs to no declared module`);
    } else if (owners.length > 1) {
      errors.push(
        `rule 1: ${file}: production file belongs to multiple modules: ${owners.map((module) => module.id).join(', ')}`,
      );
    } else {
      ownerByFile.set(file, owners[0]!);
    }
  }
  const kernelFiles = files.filter((file) => file.startsWith('services/kernel/src/'));
  for (const read of findLoadTimeReads(root, graph, kernelFiles)) {
    const owner = ownerByFile.get(read.file);
    if (owner)
      add(
        owner.id,
        'rule 9',
        read.file,
        `load-time initializer ${read.initializer} reads ${read.binding} from ${read.specifier} at ${read.line}:${read.column}`,
      );
  }
  for (const parseError of graph.parseErrors) errors.push(`parser: ${parseError}`);
  errors.push(...validateBaseline(baseline));
  const modules = new Map(manifest.modules.map((module) => [module.id, module]));
  for (const [moduleId, group] of Object.entries(baseline.modules)) {
    if (!group || typeof group !== 'object') continue;
    const module = modules.get(moduleId);
    if (!module) errors.push(`rule 8: baseline module ${moduleId} has no manifest owner`);
    if (module && group.owner !== module.owner)
      errors.push(
        `rule 8: baseline module ${moduleId} owner ${group.owner} does not match manifest owner ${module.owner}`,
      );
    if (group.reason !== 'pre-boundary code')
      errors.push(`rule 8: baseline module ${moduleId} must use reason pre-boundary code`);
  }
  const packages = packageRoots(root, manifest);
  const exportTargets = packageExportTargetMap(root, manifest);
  const locatedEdges: LocatedEdge[] = [];

  for (const [source, imports] of Object.entries(graph.imports)) {
    const sourceModule = ownerByFile.get(source);
    if (!sourceModule) continue;
    const sourceIsPackage = source.startsWith('packages/');
    for (const edge of imports) {
      if (
        (sourceModule.kind === 'core' || sourceModule.kind === 'contract') &&
        forbiddenEffectImport(edge.specifier, edge.targets[0])
      ) {
        add(sourceModule.id, 'rule 4', source, stableEdge(edge, edge.targets[0] ?? 'external'));
      }
      const targetPackage = packageName(edge.specifier);
      const targetWorkspace = targetPackage ? packages.get(targetPackage) : undefined;
      if (
        sourceIsPackage &&
        edge.targets.length === 0 &&
        targetWorkspace &&
        /^(apps|services)\//.test(slash(relative(root, targetWorkspace)))
      ) {
        add(sourceModule.id, 'rule 7', source, stableEdge(edge, edge.targets[0] ?? targetWorkspace));
      }

      for (const target of edge.targets) {
        const targetModule = ownerByFile.get(target);
        if (sourceIsPackage && /^(apps|services)\//.test(target)) {
          add(sourceModule.id, 'rule 7', source, stableEdge(edge, target));
        }
        if (!targetModule) continue;
        locatedEdges.push({ source, sourceModule, edge, target, targetModule });
        if (sourceModule.id === targetModule.id) continue;
        const publicTarget = isPublicTarget(edge.specifier, target, targetModule, exportTargets);
        if (!publicTarget)
          add(sourceModule.id, 'rule 2', source, stableEdge(edge, target), `${sourceModule.id} -> ${targetModule.id}`);
        if (
          !(
            sourceModule.allowedDependencies.includes('*') || sourceModule.allowedDependencies.includes(targetModule.id)
          )
        ) {
          add(
            sourceModule.id,
            'rule 3',
            source,
            stableEdge(edge, `${target} (${targetModule.id} is not an allowed dependency)`),
            `${sourceModule.id} -> ${targetModule.id}`,
          );
        }
        if (moduleRank(sourceModule.kind) < moduleRank(targetModule.kind)) {
          add(
            sourceModule.id,
            'rule 3',
            source,
            stableEdge(edge, `${target} (${sourceModule.kind} cannot depend on ${targetModule.kind})`),
            `${sourceModule.id} -> ${targetModule.id}`,
          );
        }
        if (
          (sourceModule.kind === 'application' && ['adapter', 'composition root'].includes(targetModule.kind)) ||
          (sourceModule.kind === 'adapter' && targetModule.kind === 'composition root')
        ) {
          add(
            sourceModule.id,
            'rule 5',
            source,
            stableEdge(edge, `${target} (${sourceModule.kind} cannot select or import ${targetModule.kind})`),
            `${sourceModule.id} -> ${targetModule.id}`,
          );
        }
        if (
          sourceModule.kind === 'adapter' &&
          targetModule.kind === 'adapter' &&
          !sourceModule.allowedDependencies.includes(targetModule.id)
        ) {
          add(
            sourceModule.id,
            'rule 5',
            source,
            stableEdge(edge, `${target} (unrelated adapter ${targetModule.id})`),
            `${sourceModule.id} -> ${targetModule.id}`,
          );
        }
      }

      if (edge.specifier.endsWith('.sql') || edge.targets.some((target) => target.endsWith('.sql'))) {
        const postgresImport = sourceModule.kind === 'adapter' && matchesAny(source, sourceModule.postgresPaths);
        if (!postgresImport) add(sourceModule.id, 'rule 5', source, stableEdge(edge, edge.targets[0] ?? 'SQL module'));
      }
    }
  }

  const sourceFiles = files.filter((file) => CODE_EXTENSIONS.has(extname(file)));
  const valueFileEdges: Array<[string, string]> = [];
  for (const located of locatedEdges) {
    if (located.edge.kind === 'value') valueFileEdges.push([located.source, located.target]);
  }
  const fileComponents = stronglyConnectedComponents(sourceFiles, valueFileEdges);
  for (const component of fileComponents) {
    const members = new Set(component);
    const cyclic =
      component.length > 1 || valueFileEdges.some(([source, target]) => source === target && members.has(source));
    if (!cyclic) continue;
    for (const located of locatedEdges) {
      if (located.edge.kind === 'value' && members.has(located.source) && members.has(located.target)) {
        add(
          located.sourceModule.id,
          'rule 3',
          located.source,
          stableEdge(located.edge, `${located.target} (value-import cycle)`),
        );
      }
    }
  }

  const moduleEdges: Array<[string, string]> = locatedEdges
    .filter((edge) => edge.sourceModule.id !== edge.targetModule.id)
    .map((edge) => [edge.sourceModule.id, edge.targetModule.id]);
  const moduleComponents = stronglyConnectedComponents([...modules.keys()], moduleEdges);
  for (const component of moduleComponents) {
    const members = new Set(component);
    const cyclic =
      component.length > 1 || moduleEdges.some(([source, target]) => source === target && members.has(source));
    if (!cyclic) continue;
    const reportedPairs = new Set<string>();
    for (const located of locatedEdges) {
      if (
        members.has(located.sourceModule.id) &&
        members.has(located.targetModule.id) &&
        located.sourceModule.id !== located.targetModule.id
      ) {
        const pair = `${located.sourceModule.id}\n${located.targetModule.id}`;
        if (reportedPairs.has(pair)) continue;
        reportedPairs.add(pair);
        add(
          located.sourceModule.id,
          'rule 3',
          `<module:${located.sourceModule.id}>`,
          `${located.sourceModule.id} => ${located.targetModule.id} (module dependency cycle)`,
        );
      }
    }
  }

  const baselineEntries = baselineLookup(baseline);
  const currentKeys = new Set<string>();
  for (const [moduleId, group] of currentByModule) {
    for (const violation of group.values()) {
      const lookupKey = `${moduleId}\n${baselineKey(violation)}`;
      currentKeys.add(lookupKey);
      if (!baselineEntries.has(lookupKey)) {
        const context = diagnosticContexts.get(lookupKey);
        errors.push(`${violation.rule}: ${violation.file}: ${violation.edge}${context ? ` [modules ${context}]` : ''}`);
      }
      violations.push(violation);
    }
  }
  let removed = 0;
  for (const [moduleId, group] of Object.entries(baseline.modules)) {
    for (const violation of group.violations) {
      const key = `${moduleId}\n${baselineKey(violation)}`;
      if (!currentKeys.has(key)) removed += 1;
    }
  }
  if (removed) warnings.push(`Boundary baseline can shrink by ${removed} entr${removed === 1 ? 'y' : 'ies'}.`);
  return { errors: [...new Set(errors)].sort(), warnings, violations };
}

export function loadBaseline(rootInput: string): BoundaryBaseline {
  return JSON.parse(readFileSync(join(resolve(rootInput), BASELINE_PATH), 'utf8')) as BoundaryBaseline;
}

function gitOutput(root: string, args: string[], allowMissing = false): string | undefined {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing) return undefined;
    throw new Error((result.stderr || `git ${args.join(' ')} exited ${result.status}`).trim());
  }
  return result.stdout ?? '';
}

function gitBaseFiles(root: string, base: string, manifest: ArchitectureManifest): string[] {
  const paths = gitOutput(root, ['ls-tree', '-r', '--name-only', '-z', base])!.split('\0').filter(Boolean);
  return paths
    .filter((path) => {
      return manifest.sourceRoots.some((candidate) => {
        const prefix = candidate.path.endsWith('/') ? candidate.path : `${candidate.path}/`;
        if (!path.startsWith(prefix) || !isIncludedByRoot(path, candidate)) return false;
        const relativePath = path.slice(prefix.length);
        return !relativePath
          .split('/')
          .slice(0, -1)
          .some((part) => part.startsWith('.') || part === 'node_modules');
      });
    })
    .sort();
}

function gitBaseText(root: string, base: string, path: string): string | undefined {
  return gitOutput(root, ['show', `${base}:${path}`], true);
}

function architectureEnvironmentPaths(manifest: ArchitectureManifest): Set<string> {
  const paths = new Set<string>(['tsconfig.base.json']);
  for (const sourceRoot of manifest.sourceRoots) {
    const workspace = workspaceForPath(sourceRoot.path);
    if (workspace) {
      paths.add(`${workspace}/package.json`);
      paths.add(`${workspace}/tsconfig.json`);
    }
  }
  return paths;
}

function changedArchitectureGraph(
  root: string,
  base: string,
  currentManifest: ArchitectureManifest,
  currentGraph: ArchitectureGraph,
  changedPaths: readonly string[],
): { manifest: ArchitectureManifest; baseline: BoundaryBaseline; graph: ArchitectureGraph } {
  const baseManifestText = gitBaseText(root, base, MANIFEST_PATH);
  const baseBaselineText = gitBaseText(root, base, BASELINE_PATH);
  if (!baseManifestText || !baseBaselineText)
    throw new Error('Captured base is missing the architecture manifest or boundary baseline.');
  const manifest = JSON.parse(baseManifestText) as ArchitectureManifest;
  const baseline = JSON.parse(baseBaselineText) as BoundaryBaseline;

  const environmentPaths = new Set([
    ...architectureEnvironmentPaths(manifest),
    ...architectureEnvironmentPaths(currentManifest),
  ]);

  const baseFiles = gitBaseFiles(root, base, manifest);
  const baseFileSet = new Set(baseFiles);
  const currentFiles = new Set(Object.keys(currentGraph.hashes));
  const baseImports = new Map<string, ImportEdge[]>();
  const baseHashes: Record<string, string> = {};
  const parseErrors: string[] = [];
  const changedSet = new Set(changedPaths);

  for (const file of baseFiles) {
    const source = changedSet.has(file) || !currentFiles.has(file) ? gitBaseText(root, base, file) : undefined;
    if (source !== undefined) {
      baseHashes[file] = sha256(source);
      const parsed = collectImports(source, file);
      parseErrors.push(...parsed.errors);
      baseImports.set(file, parsed.imports);
    } else {
      baseHashes[file] = currentGraph.hashes[file]!;
      baseImports.set(file, currentGraph.imports[file] ?? []);
      parseErrors.push(...currentGraph.parseErrors.filter((error) => error.startsWith(`${file}:`)));
    }
  }

  const baseOverrides = new Map<string, string | null>();
  for (const path of environmentPaths) baseOverrides.set(resolve(root, path), gitBaseText(root, base, path) ?? null);
  fileOverrides.clear();
  for (const [path, value] of baseOverrides) fileOverrides.set(path, value);
  pathMappingsCache.clear();
  jsonCache.clear();
  try {
    const unchangedResolution =
      canonical(currentManifest) === canonical(manifest) &&
      currentGraph.environmentHash === environmentHash(root, manifest) &&
      baseFiles.length === currentFiles.size &&
      baseFiles.every((file) => currentFiles.has(file));
    const packages = packageRoots(root, manifest);
    const imports: Record<string, ImportEdge[]> = {};
    for (const file of baseFiles) {
      if (unchangedResolution && !changedSet.has(file)) {
        imports[file] = currentGraph.imports[file] ?? [];
      } else {
        imports[file] = (baseImports.get(file) ?? []).map((edge) => ({
          ...edge,
          targets: resolveSpecifier(root, file, edge.specifier, packages, baseFileSet),
        }));
      }
    }
    return {
      manifest,
      baseline,
      graph: {
        version: 1,
        manifestHash: sha256(canonical(manifest)),
        environmentHash: environmentHash(root, manifest),
        hashes: baseHashes,
        imports,
        parseErrors,
      },
    };
  } finally {
    fileOverrides.clear();
    pathMappingsCache.clear();
    jsonCache.clear();
  }
}

function newBaselineEntries(previous: BoundaryBaseline, current: BoundaryBaseline): string[] {
  const existing = new Set<string>();
  for (const [moduleId, group] of Object.entries(previous.modules)) {
    for (const violation of group.violations) existing.add(`${moduleId}\n${baselineKey(violation)}`);
  }
  const added: string[] = [];
  for (const [moduleId, group] of Object.entries(current.modules)) {
    for (const violation of group.violations) {
      const key = `${moduleId}\n${baselineKey(violation)}`;
      if (!existing.has(key)) added.push(`${violation.file}: ${violation.edge}`);
    }
  }
  return added.sort();
}

function architectureErrorIdentity(error: string): string {
  return error.replace(/ #\d+ =>/g, ' =>');
}

function changedPathsFromBase(root: string, base: string): string[] {
  const tracked = gitOutput(root, ['diff', '--name-only', '--no-renames', '-z', base, '--'])!;
  const untracked = gitOutput(root, ['ls-files', '--others', '--exclude-standard', '-z'])!;
  return [
    ...new Set(
      `${tracked}\0${untracked}`
        .split('\0')
        .filter(Boolean)
        .map((path) => slash(relative(root, resolve(root, path)))),
    ),
  ].sort();
}

function architectureInputsUnchanged(
  root: string,
  base: string,
  manifest: ArchitectureManifest,
  baseline: BoundaryBaseline,
): boolean {
  const baseManifestText = gitBaseText(root, base, MANIFEST_PATH);
  const baseBaselineText = gitBaseText(root, base, BASELINE_PATH);
  if (!baseManifestText || !baseBaselineText) return false;
  const baseManifest = JSON.parse(baseManifestText) as ArchitectureManifest;
  const baseBaseline = JSON.parse(baseBaselineText) as BoundaryBaseline;
  if (canonical(baseManifest) !== canonical(manifest) || canonical(baseBaseline) !== canonical(baseline)) return false;

  const currentFiles = enumerateProductionFiles(root, manifest);
  const baseFiles = gitBaseFiles(root, base, manifest);
  if (currentFiles.length !== baseFiles.length || currentFiles.some((file, index) => file !== baseFiles[index]))
    return false;

  const environmentPaths = architectureEnvironmentPaths(manifest);
  const relevantPaths = new Set([MANIFEST_PATH, BASELINE_PATH, ...environmentPaths]);
  for (const path of changedPathsFromBase(root, base)) {
    if (relevantPaths.has(path) || manifest.sourceRoots.some((sourceRoot) => isIncludedByRoot(path, sourceRoot)))
      return false;
  }
  for (const path of environmentPaths) {
    const baseText = gitBaseText(root, base, path);
    let currentText: string | undefined;
    try {
      currentText = readFileSync(join(root, path), 'utf8');
    } catch {
      currentText = undefined;
    }
    if (baseText !== currentText) return false;
  }
  return true;
}

function architectureDeltaErrors(
  root: string,
  base: string,
  manifest: ArchitectureManifest,
  baseline: BoundaryBaseline,
  currentGraph: ArchitectureGraph,
  currentResult: AuditResult,
): AuditResult {
  const changedPaths = changedPathsFromBase(root, base);
  const previous = changedArchitectureGraph(root, base, manifest, currentGraph, changedPaths);
  const previousResult = auditArchitecture(root, previous.manifest, previous.baseline, previous.graph);
  const previousCounts = new Map<string, number>();
  for (const error of previousResult.errors) {
    const identity = architectureErrorIdentity(error);
    previousCounts.set(identity, (previousCounts.get(identity) ?? 0) + 1);
  }
  const errors: string[] = [];
  for (const error of currentResult.errors) {
    const identity = architectureErrorIdentity(error);
    const count = previousCounts.get(identity) ?? 0;
    if (count) previousCounts.set(identity, count - 1);
    else errors.push(error);
  }
  for (const added of newBaselineEntries(previous.baseline, baseline))
    errors.push(`rule 8: boundary baseline may only shrink; added ${added}`);
  return {
    errors: [...new Set(errors)].sort(),
    warnings: currentResult.warnings,
    violations: currentResult.violations,
  };
}

function parseArguments(args: string[]): { changed: string[]; changedBase?: string; map: boolean } {
  const changed: string[] = [];
  let changedBase: string | undefined;
  let map = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--map') {
      map = true;
    } else if (argument === '--changed') {
      while (args[index + 1] && !args[index + 1]!.startsWith('--')) changed.push(args[++index]!);
      if (!changed.length) throw new Error('--changed requires a base commit or one or more file paths.');
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (changed.length === 1 && /^[0-9a-f]{7,64}$/i.test(changed[0]!)) {
    changedBase = changed.pop();
  }
  if (map && changed.length + Number(Boolean(changedBase)) > 0)
    throw new Error('--map and --changed are separate modes.');
  return { changed, ...(changedBase ? { changedBase } : {}), map };
}

async function main(): Promise<void> {
  const root = process.cwd();
  let args: ReturnType<typeof parseArguments>;
  try {
    args = parseArguments(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  let manifest: ArchitectureManifest;
  let baseline: BoundaryBaseline;
  try {
    manifest = loadManifest(root);
    baseline = loadBaseline(root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length) {
    for (const error of manifestErrors) console.error(error);
    process.exitCode = 1;
    return;
  }
  if (args.map) {
    try {
      console.log(formatModuleMap(manifest));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  if (args.changedBase) {
    try {
      gitOutput(root, ['rev-parse', '--verify', `${args.changedBase}^{commit}`]);
      if (architectureInputsUnchanged(root, args.changedBase, manifest, baseline)) {
        console.log(
          `Architecture check passed (production architecture inputs unchanged against base ${args.changedBase}).`,
        );
        return;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
      return;
    }
  }

  let graph: ArchitectureGraph;
  try {
    graph = args.changedBase
      ? buildGraph(root, manifest)
      : args.changed.length
        ? changedGraph(root, manifest, args.changed)
        : buildGraph(root, manifest);
    if (args.changedBase || !args.changed.length) writeGraphCache(root, graph);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const audited = auditArchitecture(root, manifest, baseline, graph);
  let result = audited;
  if (args.changedBase) {
    try {
      result = architectureDeltaErrors(root, args.changedBase, manifest, baseline, graph, audited);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
      return;
    }
  }
  for (const warning of result.warnings) console.warn(warning);
  for (const error of result.errors) console.error(error);
  if (result.errors.length) process.exitCode = 1;
  else
    console.log(
      args.changedBase
        ? `Architecture check passed (${Object.keys(graph.hashes).length} production files against base ${args.changedBase}).`
        : `Architecture check passed (${Object.keys(graph.hashes).length} production files).`,
    );
}

if (import.meta.main) await main();
