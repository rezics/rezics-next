import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

export type ModuleKind =
  | "contract"
  | "core"
  | "application"
  | "adapter"
  | "composition root"
  | "UI/transport library";

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
  kind: "value" | "type";
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

const MANIFEST_PATH = "docs/architecture/modules.json";
const BASELINE_PATH = "docs/architecture/boundary-baseline.json";
const CACHE_PATH = ".temp/architecture/graph.json";
const KINDS = new Set<ModuleKind>([
  "contract",
  "core",
  "application",
  "adapter",
  "composition root",
  "UI/transport library",
]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const EMITTED_SOURCE_EXTENSIONS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts", ".js"],
  ".jsx": [".tsx", ".ts", ".d.ts", ".jsx"],
  ".mjs": [".mts", ".d.ts", ".mjs"],
  ".cjs": [".cts", ".d.ts", ".cjs"],
};
const FORBIDDEN_PACKAGES = new Set(["elysia", "pg", "react", "react-dom"]);
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "stream",
  "timers",
  "url",
  "util",
  "worker_threads",
]);

const pathMappingsCache = new Map<string, { baseUrl: string; paths: Record<string, string[]> }>();
const transpilerCache = new Map<string, Bun.Transpiler>();
const jsonCache = new Map<string, Record<string, unknown> | undefined>();
const globCache = new Map<string, RegExp>();

function slash(path: string): string {
  return path.split(sep).join("/");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function globRegex(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if ("\\.+?^${}()|[]".includes(character)) {
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
  const segments = path.split("/");
  if (["apps", "services", "packages"].includes(segments[0] ?? "") && segments.length >= 2) {
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
    const result = JSON.parse(readFileSync(absolute, "utf8")) as Record<string, unknown>;
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
    const packagePath = join(root, workspace, "package.json");
    const value = readJson(packagePath);
    if (typeof value?.name === "string") packages.set(value.name, join(root, workspace));
  }
  return packages;
}

function packageName(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return undefined;
  }
  const clean = specifier.split(/[?#]/, 1)[0]!;
  const parts = clean.split("/");
  return clean.startsWith("@") ? (parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]) : parts[0];
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
          if (!entry.name.startsWith(".") && entry.name !== "node_modules") visit(absolutePath);
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
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".d.ts", ".json", ".sql", ".css", ".yaml", ".yml", ".svg"]) {
      candidates.push(`${normalized}${extension}`);
    }
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".json"]) candidates.push(`${normalized}/index${extension}`);
  }
  return candidates.filter((path) => knownFiles.has(path));
}

function exportKeys(exportsValue: unknown): Array<[string, unknown]> {
  if (typeof exportsValue === "string" || Array.isArray(exportsValue) || exportsValue === null || typeof exportsValue !== "object") {
    return [[".", exportsValue]];
  }
  const entries = Object.entries(exportsValue as Record<string, unknown>);
  return entries.some(([key]) => key.startsWith(".")) ? entries : [[".", exportsValue]];
}

function exportKeyMatches(exportKey: string, subpath: string): { matched: boolean; wildcard?: string } {
  if (exportKey === subpath) return { matched: true };
  const star = exportKey.indexOf("*");
  if (star < 0 || exportKey.indexOf("*", star + 1) >= 0) return { matched: false };
  const prefix = exportKey.slice(0, star);
  const suffix = exportKey.slice(star + 1);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) {
    return { matched: false };
  }
  return { matched: true, wildcard: subpath.slice(prefix.length, subpath.length - suffix.length) };
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  return Object.values(value as Record<string, unknown>).flatMap(exportTargets);
}

function parseJsonc(source: string): string {
  let output = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
    } else if (character === '"') {
      quote = true;
      output += character;
    } else if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      if (index < source.length) output += "\n";
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        output += "  ";
        index += 1;
      }
    } else {
      output += character;
    }
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function readPathMappings(root: string, sourcePath: string): { baseUrl: string; paths: Record<string, string[]> } {
  const configPath = join(workspaceRootForFile(root, sourcePath), "tsconfig.json");
  const cached = pathMappingsCache.get(configPath);
  if (cached) return cached;
  const visiting = new Set<string>();
  const readConfig = (path: string): { baseUrl: string; paths: Record<string, string[]> } => {
    const absolute = resolve(path);
    if (visiting.has(absolute)) return { baseUrl: dirname(absolute), paths: {} };
    visiting.add(absolute);
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(parseJsonc(readFileSync(absolute, "utf8"))) as Record<string, unknown>;
    } catch {
      visiting.delete(absolute);
      return { baseUrl: dirname(absolute), paths: {} };
    }
    const parentRefs = Array.isArray(config.extends) ? config.extends : config.extends ? [config.extends] : [];
    let parent = { baseUrl: dirname(absolute), paths: {} as Record<string, string[]> };
    for (const reference of parentRefs) {
      if (typeof reference !== "string" || reference.startsWith("@")) continue;
      let target = resolve(dirname(absolute), reference);
      if (!extname(target)) target += ".json";
      parent = readConfig(target);
    }
    const options = config.compilerOptions && typeof config.compilerOptions === "object"
      ? config.compilerOptions as Record<string, unknown>
      : {};
    const baseUrl = typeof options.baseUrl === "string"
      ? resolve(dirname(absolute), options.baseUrl)
      : options.paths
        ? dirname(absolute)
        : parent.baseUrl;
    const paths = options.paths && typeof options.paths === "object" && !Array.isArray(options.paths)
      ? Object.fromEntries(Object.entries(options.paths as Record<string, unknown>).flatMap(([key, values]) =>
          Array.isArray(values) ? [[key, values.filter((value): value is string => typeof value === "string")]] : [],
        ))
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
    const star = pattern.indexOf("*");
    let wildcard: string | undefined;
    if (star < 0) {
      if (pattern === specifier) wildcard = "";
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
    if (wildcard === undefined) continue;
    for (const replacement of replacements) {
      const substituted = replacement.replace("*", wildcard);
      for (const target of resolveCandidate(root, join(relative(root, baseUrl), substituted), knownFiles)) targets.add(target);
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
  const metadata = readJson(join(workspacePath, "package.json"));
  if (!metadata) return [];
  const suffix = specifier.slice(name.length);
  const requestedSubpath = suffix ? `.${suffix}` : ".";
  const exportsValue = metadata.exports;
  const results = new Set<string>();
  for (const [key, value] of exportKeys(exportsValue)) {
    const match = exportKeyMatches(key, requestedSubpath);
    if (!match.matched) continue;
    for (const target of exportTargets(value)) {
      if (!target.startsWith("./")) continue;
      const substituted = match.wildcard === undefined ? target : target.replaceAll("*", match.wildcard);
      for (const path of resolveCandidate(root, join(relative(root, workspacePath), substituted), knownFiles)) results.add(path);
    }
  }
  // Resolve deep workspace paths as well so the boundary check can reject export bypasses.
  if (!results.size && suffix.startsWith("/")) {
    for (const path of resolveCandidate(root, join(relative(root, workspacePath), suffix.slice(1)), knownFiles)) results.add(path);
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
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    for (const path of resolveCandidate(root, join(dirname(fromPath), specifier), knownFiles)) targets.add(path);
  } else {
    for (const path of aliasTargets(root, fromPath, specifier, knownFiles)) targets.add(path);
    const name = packageName(specifier);
    const workspacePath = name ? packages.get(name) : undefined;
    if (workspacePath) {
      const suffix = specifier.slice(name!.length).replace(/^\//, "");
      if (suffix) {
        for (const path of resolveCandidate(root, join(relative(root, workspacePath), suffix), knownFiles)) targets.add(path);
      }
    }
  }
  return [...targets].sort();
}

function collectImports(source: string, file: string): { imports: ImportEdge[]; errors: string[] } {
  const extension = extname(file);
  if (!CODE_EXTENSIONS.has(extension)) return { imports: [], errors: [] };
  const loader = extension === ".tsx" || extension === ".jsx" ? "tsx" : extension === ".js" || extension === ".mjs" || extension === ".cjs" ? "js" : "ts";
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
    if (!message.includes("Falling back to classic runtime")) errors.push(`${file}: parser: ${message}`);
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
      const kind = explicitType ? "type" : scannerAvailable ? (remaining === 0 ? "type" : "value") : "value";
      if (!explicitType && remaining > 0) valueImports.set(specifier, remaining - 1);
      const position = start + match[0].lastIndexOf(specifier);
      const before = source.slice(0, position);
      imports.push({
        specifier,
        kind,
        line: before.split("\n").length,
        column: position - before.lastIndexOf("\n"),
        targets: [],
      });
    }
  }
  for (const [specifier, remaining] of valueImports) {
    for (let index = 0; index < remaining; index += 1) {
      const position = source.indexOf(specifier);
      const before = source.slice(0, Math.max(position, 0));
      imports.push({ specifier, kind: "value", line: before.split("\n").length, column: Math.max(position, 0) - before.lastIndexOf("\n"), targets: [] });
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
  const regexPrefixWords = new Set(["await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield"]);
  let state: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" | "regex" = "code";
  let escaped = false;
  let inRegexClass = false;
  let canStartRegex = true;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        state = "line-comment";
        index += 1;
      } else if (character === "/" && next === "*") {
        state = "block-comment";
        index += 1;
      } else if (character === "'" || character === '"' || character === "`") {
        state = character === "'" ? "single" : character === '"' ? "double" : "template";
        escaped = false;
        canStartRegex = false;
      } else if (character === "/" && canStartRegex) {
        state = "regex";
        escaped = false;
        inRegexClass = false;
      } else if (/[A-Za-z_$]/.test(character ?? "")) {
        const start = index;
        while (index + 1 < source.length && /[\w$]/.test(source[index + 1]!)) index += 1;
        code.fill(1, start, index + 1);
        canStartRegex = regexPrefixWords.has(source.slice(start, index + 1));
      } else if (/[0-9]/.test(character ?? "")) {
        const start = index;
        while (index + 1 < source.length && /[\w.]/.test(source[index + 1]!)) index += 1;
        code.fill(1, start, index + 1);
        canStartRegex = false;
      } else {
        code[index] = 1;
        if (!/\s/.test(character ?? "")) canStartRegex = ![")", "]", "}", "."].includes(character ?? "");
      }
    } else if (state === "line-comment") {
      if (character === "\n") state = "code";
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
    } else if (state === "single" || state === "double" || state === "template") {
      const delimiter = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === delimiter) {
        state = "code";
        canStartRegex = false;
      }
    } else if (state === "regex") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "[") inRegexClass = true;
      else if (character === "]") inRegexClass = false;
      else if (character === "/" && !inRegexClass) {
        state = "code";
        canStartRegex = false;
        while (index + 1 < source.length && /[A-Za-z]/.test(source[index + 1]!)) index += 1;
      }
    }
  }
  return code;
}

function environmentHash(root: string, manifest: ArchitectureManifest): string {
  const paths = new Set<string>(["tsconfig.base.json"]);
  for (const sourceRoot of manifest.sourceRoots) {
    const workspace = workspaceForPath(sourceRoot.path);
    if (!workspace) continue;
    paths.add(`${workspace}/package.json`);
    paths.add(`${workspace}/tsconfig.json`);
  }
  const values = [...paths].sort().map((path) => {
    try {
      return [path, sha256(readFileSync(join(root, path)))];
    } catch {
      return [path, "missing"];
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
    const parsed = collectImports(source.toString("utf8"), file);
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
    return JSON.parse(readFileSync(cachePath(root), "utf8")) as ArchitectureGraph;
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
  if (!cached) throw new Error("No complete architecture graph cache; run bun scripts/architecture.ts first.");
  const expectedManifestHash = sha256(canonical(manifest));
  const expectedEnvironmentHash = environmentHash(root, manifest);
  if (cached.manifestHash !== expectedManifestHash || cached.environmentHash !== expectedEnvironmentHash) {
    throw new Error("Architecture manifest or workspace resolution changed; run bun scripts/architecture.ts first.");
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
    throw new Error(`--changed omitted modified source files: ${omissions.sort().join(", ")}`);
  }

  const structureChanged = Object.keys(cached.hashes).some((file) => !fileSet.has(file)) || files.some((file) => !(file in cached.hashes));
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
    const parsed = collectImports(readFileSync(join(root, file), "utf8"), file);
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

function moduleForFile(path: string, manifest: ArchitectureManifest): ArchitectureModule[] {
  return manifest.modules.filter((module) => matchesAny(path, module.paths) && !matchesAny(path, module.excludes));
}

export function moduleIdForFile(path: string, manifest: ArchitectureManifest): string | undefined {
  return moduleForFile(path, manifest)[0]?.id;
}

function moduleRank(kind: ModuleKind): number {
  switch (kind) {
    case "contract":
      return 0;
    case "core":
      return 1;
    case "application":
      return 2;
    case "adapter":
    case "UI/transport library":
      return 3;
    case "composition root":
      return 4;
  }
}

export function validateManifest(manifest: ArchitectureManifest): string[] {
  const errors: string[] = [];
  if (manifest.version !== 1) errors.push(`manifest version must be 1 (received ${manifest.version})`);
  if (!Array.isArray(manifest.sourceRoots) || !Array.isArray(manifest.modules)) return [...errors, "manifest sourceRoots and modules must be arrays"];
  const ids = new Set<string>();
  const capabilities = new Map<string, string>();
  for (const module of manifest.modules) {
    if (!module.id || ids.has(module.id)) errors.push(`duplicate or empty module id: ${module.id || "<empty>"}`);
    ids.add(module.id);
    if (!KINDS.has(module.kind)) errors.push(`${module.id}: unsupported kind ${String(module.kind)}`);
    if (!module.owner?.trim()) errors.push(`${module.id}: owner Goal is required`);
    if (!Array.isArray(module.paths) || module.paths.length === 0) errors.push(`${module.id}: at least one path is required`);
    if (!Array.isArray(module.publicEntries) || !Array.isArray(module.allowedDependencies) || !Array.isArray(module.capabilities)) {
      errors.push(`${module.id}: publicEntries, allowedDependencies, and capabilities must be arrays`);
    }
    for (const capability of module.capabilities ?? []) {
      const owner = capabilities.get(capability);
      if (owner && owner !== module.owner) errors.push(`${module.id}: capability ${capability} is also owned by ${owner}`);
      capabilities.set(capability, module.owner);
    }
  }
  for (const module of manifest.modules) {
    for (const dependency of module.allowedDependencies ?? []) {
      if (dependency !== "*" && !ids.has(dependency)) errors.push(`${module.id}: unknown allowed dependency ${dependency}`);
    }
    if ((module.allowedDependencies ?? []).includes(module.id)) errors.push(`${module.id}: a module cannot allow itself as a dependency`);
  }
  for (const sourceRoot of manifest.sourceRoots) {
    if (!sourceRoot.path || !Array.isArray(sourceRoot.extensions) || sourceRoot.extensions.length === 0) {
      errors.push(`source root ${sourceRoot.path || "<empty>"}: path and extensions are required`);
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
  if (!baseline.modules || typeof baseline.modules !== "object" || Array.isArray(baseline.modules)) {
    return [...errors, "baseline modules must be grouped by module"];
  }
  const seen = new Set<string>();
  for (const [moduleId, group] of Object.entries(baseline.modules)) {
    if (!group || typeof group !== "object") {
      errors.push(`rule 8: baseline module ${moduleId} must have an owner, reason, and violations`);
      continue;
    }
    for (const violation of group.violations ?? []) {
      const detail = `${violation.file || "<missing file>"}: ${violation.edge || "<missing edge>"}`;
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
    const metadata = readJson(join(root, workspace, "package.json"));
    if (!metadata || typeof metadata.name !== "string") continue;
    for (const [key, value] of exportKeys(metadata.exports)) {
      const publicEntry = key === "." ? metadata.name : `${metadata.name}${key.slice(1)}`;
      for (const target of exportTargets(value)) {
        if (!target.startsWith("./")) continue;
        const wildcard = key.indexOf("*");
        const starTarget = target.indexOf("*");
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
  const normalized = (name ?? specifier).replace(/^node:/, "");
  return (
    specifier === "bun" ||
    specifier.startsWith("bun:") ||
    specifier.startsWith("node:") ||
    NODE_BUILTINS.has(normalized) ||
    NODE_BUILTINS.has(normalized.replace(/^node:/, ""))
  );
}

function forbiddenEffectImport(specifier: string, target: string | undefined): boolean {
  const name = packageName(specifier);
  return (
    (name !== undefined && (FORBIDDEN_PACKAGES.has(name) || name.toLowerCase().includes("dbos"))) ||
    forbiddenRuntimeImport(specifier) ||
    specifier.endsWith(".sql") ||
    Boolean(target?.endsWith(".sql"))
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
      reason: "pre-boundary code",
      violations: [...unique.values()].sort((left, right) => baselineKey(left).localeCompare(baselineKey(right))),
    };
  }
  return result;
}

export function dependenciesFromGraph(manifest: ArchitectureManifest, graph: ArchitectureGraph): Record<string, string[]> {
  const dependencies = new Map(manifest.modules.map((module) => [module.id, new Set<string>()]));
  for (const [source, imports] of Object.entries(graph.imports)) {
    const sourceModule = moduleForFile(source, manifest)[0];
    if (!sourceModule) continue;
    for (const edge of imports) {
      for (const target of edge.targets) {
        const targetModule = moduleForFile(target, manifest)[0];
        if (targetModule && targetModule.id !== sourceModule.id) dependencies.get(sourceModule.id)?.add(targetModule.id);
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
  const add = (moduleId: string, rule: string, file: string, edge: string): void => {
    const violation = { rule, file, edge };
    const group = currentByModule.get(moduleId) ?? new Map<string, BoundaryViolation>();
    group.set(baselineKey(violation), violation);
    currentByModule.set(moduleId, group);
  };

  const files = Object.keys(graph.hashes).sort();
  const ownerByFile = new Map<string, ArchitectureModule>();
  for (const file of files) {
    const owners = moduleForFile(file, manifest);
    if (owners.length === 0) {
      errors.push(`rule 1: ${file}: production file belongs to no declared module`);
    } else if (owners.length > 1) {
      errors.push(`rule 1: ${file}: production file belongs to multiple modules: ${owners.map((module) => module.id).join(", ")}`);
    } else {
      ownerByFile.set(file, owners[0]!);
    }
  }
  for (const parseError of graph.parseErrors) errors.push(`parser: ${parseError}`);
  errors.push(...validateBaseline(baseline));
  const modules = new Map(manifest.modules.map((module) => [module.id, module]));
  for (const [moduleId, group] of Object.entries(baseline.modules)) {
    if (!group || typeof group !== "object") continue;
    const module = modules.get(moduleId);
    if (!module) errors.push(`rule 8: baseline module ${moduleId} has no manifest owner`);
    if (module && group.owner !== module.owner) errors.push(`rule 8: baseline module ${moduleId} owner ${group.owner} does not match manifest owner ${module.owner}`);
    if (group.reason !== "pre-boundary code") errors.push(`rule 8: baseline module ${moduleId} must use reason pre-boundary code`);
  }
  const packages = packageRoots(root, manifest);
  const exportTargets = packageExportTargetMap(root, manifest);
  const locatedEdges: LocatedEdge[] = [];

  for (const [source, imports] of Object.entries(graph.imports)) {
    const sourceModule = ownerByFile.get(source);
    if (!sourceModule) continue;
    const sourceIsPackage = source.startsWith("packages/");
    for (const edge of imports) {
      if ((sourceModule.kind === "core" || sourceModule.kind === "contract") && forbiddenEffectImport(edge.specifier, edge.targets[0])) {
        add(sourceModule.id, "rule 4", source, stableEdge(edge, edge.targets[0] ?? "external"));
      }
      const targetPackage = packageName(edge.specifier);
      const targetWorkspace = targetPackage ? packages.get(targetPackage) : undefined;
      if (sourceIsPackage && targetWorkspace && /^(apps|services)\//.test(slash(relative(root, targetWorkspace)))) {
        add(sourceModule.id, "rule 7", source, stableEdge(edge, edge.targets[0] ?? targetWorkspace));
      }

      for (const target of edge.targets) {
        const targetModule = ownerByFile.get(target);
        if (!targetModule) continue;
        locatedEdges.push({ source, sourceModule, edge, target, targetModule });
        if (sourceModule.id === targetModule.id) continue;
        const publicTarget = isPublicTarget(edge.specifier, target, targetModule, exportTargets);
        if (!publicTarget) add(sourceModule.id, "rule 2", source, stableEdge(edge, target));
        if (!(sourceModule.allowedDependencies.includes("*") || sourceModule.allowedDependencies.includes(targetModule.id))) {
          add(sourceModule.id, "rule 3", source, stableEdge(edge, `${target} (${targetModule.id} is not an allowed dependency)`));
        }
        if (moduleRank(sourceModule.kind) < moduleRank(targetModule.kind)) {
          add(sourceModule.id, "rule 3", source, stableEdge(edge, `${target} (${sourceModule.kind} cannot depend on ${targetModule.kind})`));
        }
        if (
          (sourceModule.kind === "application" && ["adapter", "composition root"].includes(targetModule.kind)) ||
          (sourceModule.kind === "adapter" && targetModule.kind === "composition root")
        ) {
          add(sourceModule.id, "rule 5", source, stableEdge(edge, `${target} (${sourceModule.kind} cannot select or import ${targetModule.kind})`));
        }
        if (
          sourceModule.kind === "adapter" &&
          targetModule.kind === "adapter" &&
          !sourceModule.allowedDependencies.includes(targetModule.id)
        ) {
          add(sourceModule.id, "rule 5", source, stableEdge(edge, `${target} (unrelated adapter ${targetModule.id})`));
        }
      }

      if (edge.specifier.endsWith(".sql") || edge.targets.some((target) => target.endsWith(".sql"))) {
        const postgresImport = sourceModule.kind === "adapter" && matchesAny(source, sourceModule.postgresPaths);
        if (!postgresImport) add(sourceModule.id, "rule 5", source, stableEdge(edge, edge.targets[0] ?? "SQL module"));
      }
    }
  }

  const sourceFiles = files.filter((file) => CODE_EXTENSIONS.has(extname(file)));
  const valueFileEdges: Array<[string, string]> = [];
  for (const located of locatedEdges) {
    if (located.edge.kind === "value") valueFileEdges.push([located.source, located.target]);
  }
  const fileComponents = stronglyConnectedComponents(sourceFiles, valueFileEdges);
  for (const component of fileComponents) {
    const members = new Set(component);
    const cyclic = component.length > 1 || valueFileEdges.some(([source, target]) => source === target && members.has(source));
    if (!cyclic) continue;
    for (const located of locatedEdges) {
      if (located.edge.kind === "value" && members.has(located.source) && members.has(located.target)) {
        add(located.sourceModule.id, "rule 3", located.source, stableEdge(located.edge, `${located.target} (value-import cycle)`));
      }
    }
  }

  const moduleEdges: Array<[string, string]> = locatedEdges
    .filter((edge) => edge.sourceModule.id !== edge.targetModule.id)
    .map((edge) => [edge.sourceModule.id, edge.targetModule.id]);
  const moduleComponents = stronglyConnectedComponents([...modules.keys()], moduleEdges);
  for (const component of moduleComponents) {
    const members = new Set(component);
    const cyclic = component.length > 1 || moduleEdges.some(([source, target]) => source === target && members.has(source));
    if (!cyclic) continue;
    for (const located of locatedEdges) {
      if (members.has(located.sourceModule.id) && members.has(located.targetModule.id) && located.sourceModule.id !== located.targetModule.id) {
        add(located.sourceModule.id, "rule 3", located.source, stableEdge(located.edge, `${located.target} (module dependency cycle)`));
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
        errors.push(`${violation.rule}: ${violation.file}: ${violation.edge}`);
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
  if (removed) warnings.push(`Boundary baseline can shrink by ${removed} entr${removed === 1 ? "y" : "ies"}.`);
  return { errors: [...new Set(errors)].sort(), warnings, violations };
}

function moduleEntryLabel(module: ArchitectureModule): string {
  const entries = module.publicEntries;
  if (!entries.length) return "-";
  const byPackage = new Map<string, string[]>();
  const other: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      const slashAt = entry.indexOf("/");
      const secondSlash = entry.indexOf("/", slashAt + 1);
      const prefix = secondSlash < 0 ? entry : entry.slice(0, secondSlash);
      const suffix = secondSlash < 0 ? "." : entry.slice(secondSlash + 1);
      const values = byPackage.get(prefix) ?? [];
      values.push(suffix);
      byPackage.set(prefix, values);
    } else {
      other.push(entry);
    }
  }
  const compact = [...byPackage.entries()].map(([prefix, values]) => `${prefix}:{${values.sort().join(",")}}`);
  return [...compact, ...other.sort()].join(",");
}

export function formatModuleMap(manifest: ArchitectureManifest): string {
  const result = manifest.modules
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((module) => `${module.id}|${module.kind}|${module.owner}|${moduleEntryLabel(module)}`)
    .join("\n");
  if (result.length > 2_000) throw new Error(`Generated module map is ${result.length} characters; maximum is 2000.`);
  return result;
}

export function loadManifest(rootInput: string): ArchitectureManifest {
  return JSON.parse(readFileSync(join(resolve(rootInput), MANIFEST_PATH), "utf8")) as ArchitectureManifest;
}

export function loadBaseline(rootInput: string): BoundaryBaseline {
  return JSON.parse(readFileSync(join(resolve(rootInput), BASELINE_PATH), "utf8")) as BoundaryBaseline;
}

function parseArguments(args: string[]): { changed: string[]; map: boolean } {
  const changed: string[] = [];
  let map = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--map") {
      map = true;
    } else if (argument === "--changed") {
      while (args[index + 1] && !args[index + 1]!.startsWith("--")) changed.push(args[++index]!);
      if (!changed.length) throw new Error("--changed requires one or more file paths.");
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (map && changed.length) throw new Error("--map and --changed are separate modes.");
  return { changed, map };
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

  let graph: ArchitectureGraph;
  try {
    graph = args.changed.length ? changedGraph(root, manifest, args.changed) : buildGraph(root, manifest);
    if (!args.changed.length) writeGraphCache(root, graph);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const result = auditArchitecture(root, manifest, baseline, graph);
  for (const warning of result.warnings) console.warn(warning);
  for (const error of result.errors) console.error(error);
  if (result.errors.length) process.exitCode = 1;
  else console.log(`Architecture check passed (${Object.keys(graph.hashes).length} production files).`);
}

if (import.meta.main) await main();
