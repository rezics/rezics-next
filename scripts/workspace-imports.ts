import { builtinModules, createRequire } from 'node:module';
import type { Node } from 'oxc-parser';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

const { parseSync, Visitor } = createRequire(new URL('../package.json', import.meta.url))(
  'oxc-parser',
) as typeof import('oxc-parser');

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
    for (const specifier of collectModuleSpecifiers(file, source)) {
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

function collectModuleSpecifiers(file: string, source: string): string[] {
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0]!.message}`);
  const specifiers: string[] = [];
  const collect = (node: Node | null | undefined): void => {
    if (node?.type === 'Literal' && typeof node.value === 'string') specifiers.push(node.value);
  };

  // Visit syntax rather than import-shaped text: JSX, regexes and template substitutions all have distinct nodes.
  new Visitor({
    ImportDeclaration(node) {
      collect(node.source);
    },
    ExportNamedDeclaration(node) {
      collect(node.source);
    },
    ExportAllDeclaration(node) {
      collect(node.source);
    },
    ImportExpression(node) {
      collect(node.source);
    },
    TSImportType(node) {
      collect(node.source);
    },
    TSExternalModuleReference(node) {
      collect(node.expression);
    },
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') collect(node.arguments[0]);
    },
  }).visit(parsed.program);
  return specifiers;
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
