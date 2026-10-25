import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '../../..');
const KERNEL = resolve(ROOT, 'services/kernel');
export const CLIENT_DECLARATIONS = resolve(ROOT, 'packages/client/src/kernel');

function sorted(entries: Map<string, string>): Map<string, string> {
  return new Map([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function declarationFiles(directory: string, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [nested, content] of declarationFiles(path, key)) result.set(nested, content);
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      result.set(key, readFileSync(path, 'utf8'));
    }
  }
  return sorted(result);
}

function specifierTargets(content: string): string[] {
  const specifiers: string[] = [];
  const pattern = /\bfrom\s*(['"])(\.{1,2}\/[^'"]+)\1|\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\3\s*\)/g;
  for (const match of content.matchAll(pattern)) specifiers.push((match[2] ?? match[4])!);
  return specifiers;
}

function declarationPath(sourcePath: string, specifier: string): string {
  const path = resolve(dirname(sourcePath), specifier);
  if (path.endsWith('.ts')) return `${path.slice(0, -3)}.d.ts`;
  if (path.endsWith('.js')) return `${path.slice(0, -3)}.d.ts`;
  if (path.endsWith('.d.ts')) return path;
  return `${path}.d.ts`;
}

export function clientDeclarations(): Map<string, string> {
  const temporaryRoot = resolve(ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const temporaryDirectory = mkdtempSync(resolve(temporaryRoot, 'kernel-client-'));
  try {
    const compiler = resolve(ROOT, 'node_modules/.bin/tsc');
    const result = spawnSync(
      compiler,
      [
        '-p',
        'tsconfig.json',
        '--runExternalCode',
        '--noEmit',
        'false',
        '--declaration',
        '--emitDeclarationOnly',
        '--outDir',
        temporaryDirectory,
      ],
      { cwd: KERNEL, env: process.env, encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);

    const sourceRoot = resolve(temporaryDirectory, 'src');
    const pending = ['http/kernel.d.ts', 'http/request.d.ts'];
    const declarations = new Map<string, string>();
    while (pending.length) {
      const key = pending.pop()!;
      if (declarations.has(key)) continue;
      const sourcePath = resolve(sourceRoot, key);
      const content = readFileSync(sourcePath, 'utf8');
      declarations.set(key, content);
      for (const specifier of specifierTargets(content)) {
        const target = declarationPath(sourcePath, specifier);
        const targetKey = relative(sourceRoot, target).split(sep).join('/');
        if (!targetKey.startsWith('../') && !declarations.has(targetKey)) pending.push(targetKey);
      }
    }
    return sorted(declarations);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function committedDeclarations(): Map<string, string> {
  try {
    return declarationFiles(CLIENT_DECLARATIONS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

if (import.meta.main) {
  const declarations = clientDeclarations();
  rmSync(CLIENT_DECLARATIONS, { recursive: true, force: true });
  mkdirSync(CLIENT_DECLARATIONS, { recursive: true });
  for (const [key, content] of declarations) {
    const path = resolve(CLIENT_DECLARATIONS, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
