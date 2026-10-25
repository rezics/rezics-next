import { builtinModules } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

type PackageManifest = {
  name?: string;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};

type Tsconfig = {
  extends?: string | string[];
  compilerOptions?: {
    paths?: Record<string, unknown>;
  };
};

const sourceExtensions = new Set(['.ts', '.tsx', '.mts']);
const ignoredDirectories = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.output',
  '.cache',
  '.turbo',
  '.vite',
  '.wrangler',
  // `wrangler types` writes ambient declarations here; they are ignored by Git and import Workers' own modules.
  '.cloudflare',
  'coverage',
  'storybook-static',
]);
const nodeBuiltins = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith('node:') ? name.slice('node:'.length) : `node:${name}`]),
);

/** Return sorted dependency errors for every source file in each package workspace and root specs/. */
export function checkWorkspaceImports(rootDirectory: string): string[] {
  const root = resolve(rootDirectory);
  const errors: string[] = [];
  const rootManifest = readManifest(join(root, 'package.json'));

  for (const group of ['apps', 'services', 'packages']) {
    const groupDirectory = join(root, group);
    if (!isDirectory(groupDirectory)) continue;

    for (const entry of readdirSync(groupDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workspaceDirectory = join(groupDirectory, entry.name);
      const manifestPath = join(workspaceDirectory, 'package.json');
      if (!isFile(manifestPath)) continue;
      checkDirectory(root, workspaceDirectory, readManifest(manifestPath), errors);
    }
  }

  const specsDirectory = join(root, 'specs');
  if (isDirectory(specsDirectory)) checkDirectory(root, specsDirectory, rootManifest, errors);

  return errors.sort();
}

function checkDirectory(root: string, workspaceDirectory: string, manifest: PackageManifest, errors: string[]): void {
  const workspaceName = manifest.name ?? relative(root, workspaceDirectory).split(sep).join('/');
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const aliases = readPathAliases(root, workspaceDirectory);

  for (const file of sourceFiles(workspaceDirectory)) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of collectModuleSpecifiers(source)) {
      if (isExemptSpecifier(specifier, aliases)) continue;

      const packageName = packageNameOf(specifier);
      if (!packageName || packageName === manifest.name || declared.has(packageName)) continue;

      const relativeFile = relative(root, file).split(sep).join('/');
      errors.push(
        `error: ${workspaceName} ${relativeFile} imports ${packageName}, which its package.json does not declare`,
      );
    }
  }
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(path);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(directory);
  return files;
}

function isSourceFile(filename: string): boolean {
  return filename.endsWith('.d.ts') || sourceExtensions.has(extname(filename));
}

function collectModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const codeStarts = codeCharacterMap(source);
  const patterns = [
    // Imports with a from clause, including default, named, namespace and type-only imports.
    /\bimport\s+(?:type\s+)?(?:(?:[\w$]+)\s*,\s*)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)?\s+from\s*(['"])([^'"]+)\1/g,
    // Re-exports, including `export type` and namespace re-exports.
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*(['"])([^'"]+)\1/g,
    // Side-effect imports.
    /\bimport\s*(['"])([^'"]+)\1/g,
    // Literal dynamic imports and CommonJS require calls.
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!codeStarts[match.index ?? 0]) continue;
      const specifier = match[2];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
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
  let regexCharacterClass = false;
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
      } else if (character === "'") {
        state = 'single';
        escaped = false;
        canStartRegex = false;
      } else if (character === '"') {
        state = 'double';
        escaped = false;
        canStartRegex = false;
      } else if (character === '`') {
        state = 'template';
        escaped = false;
        canStartRegex = false;
      } else if (character === '/' && canStartRegex) {
        state = 'regex';
        escaped = false;
        regexCharacterClass = false;
      } else if (/[A-Za-z_$]/.test(character ?? '')) {
        const start = index;
        while (index + 1 < source.length && /[w$]/.test(source[index + 1]!)) index += 1;
        code.fill(1, start, index + 1);
        const word = source.slice(start, index + 1);
        canStartRegex = regexPrefixWords.has(word);
      } else if (/[0-9]/.test(character ?? '')) {
        const start = index;
        while (index + 1 < source.length && /[\w.]/.test(source[index + 1]!)) index += 1;
        code.fill(1, start, index + 1);
        canStartRegex = false;
      } else {
        code[index] = 1;
        if (/\s/.test(character ?? '')) continue;
        canStartRegex = ![')', ']', '}', '.', '++', '--'].includes(character ?? '');
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
      else if (character === '[') regexCharacterClass = true;
      else if (character === ']') regexCharacterClass = false;
      else if (character === '/' && !regexCharacterClass) {
        state = 'code';
        canStartRegex = false;
        while (index + 1 < source.length && /[A-Za-z]/.test(source[index + 1]!)) index += 1;
      }
    }
  }
  return code;
}

function isExemptSpecifier(specifier: string, aliases: string[]): boolean {
  if (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    isAbsolute(specifier) ||
    win32.isAbsolute(specifier) ||
    specifier.startsWith('node:') ||
    specifier === 'bun' ||
    specifier.startsWith('bun:') ||
    specifier.startsWith('cloudflare:') ||
    specifier.startsWith('virtual:') ||
    nodeBuiltins.has(specifier)
  ) {
    return true;
  }
  return aliases.some((pattern) => matchesPathAlias(pattern, specifier));
}

function packageNameOf(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('#')) return undefined;
  const packageSpecifier = specifier.split(/[?#]/, 1)[0]!;
  const segments = packageSpecifier.split('/');
  if (packageSpecifier.startsWith('@')) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : segments[0];
  return segments[0];
}

function matchesPathAlias(pattern: string, specifier: string): boolean {
  const wildcard = pattern.indexOf('*');
  if (wildcard === -1) return pattern === specifier;
  if (pattern.indexOf('*', wildcard + 1) !== -1) return false;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  return (
    specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length
  );
}

function readPathAliases(root: string, workspaceDirectory: string): string[] {
  const workspaceTsconfig = join(workspaceDirectory, 'tsconfig.json');
  const rootTsconfig = join(root, 'tsconfig.json');
  const tsconfigPath = isFile(workspaceTsconfig)
    ? workspaceTsconfig
    : workspaceTsconfig === rootTsconfig
      ? rootTsconfig
      : undefined;
  if (!tsconfigPath) return [];
  return resolveTsconfig(root, tsconfigPath).paths;
}

function resolveTsconfig(root: string, configPath: string, visited = new Set<string>()): { paths: string[] } {
  const resolved = resolve(configPath);
  if (!isWithin(root, resolved) || visited.has(resolved) || !isFile(resolved)) return { paths: [] };
  visited.add(resolved);

  const config = readTsconfig(resolved);
  let paths: string[] = [];
  const parents = Array.isArray(config.extends) ? config.extends : config.extends ? [config.extends] : [];
  for (const parent of parents) {
    const parentPath = resolveTsconfig(root, resolveExtends(dirname(resolved), parent), visited);
    paths = parentPath.paths;
  }
  const configuredPaths = config.compilerOptions?.paths;
  if (configuredPaths && typeof configuredPaths === 'object' && !Array.isArray(configuredPaths)) {
    paths = Object.keys(configuredPaths);
  }
  return { paths };
}

function resolveExtends(configDirectory: string, reference: string): string {
  const base = isAbsolute(reference) ? reference : resolve(configDirectory, reference);
  if (isFile(base)) return base;
  if (isFile(`${base}.json`)) return `${base}.json`;
  const directoryConfig = join(base, 'tsconfig.json');
  if (isFile(directoryConfig)) return directoryConfig;
  return base;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function readTsconfig(path: string): Tsconfig {
  return JSON.parse(parseJsonc(readFileSync(path, 'utf8'))) as Tsconfig;
}

function parseJsonc(source: string): string {
  let output = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
    } else if (character === '"') {
      quote = '"';
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

function isWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const errors = checkWorkspaceImports(process.cwd());
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exitCode = 1;
}
