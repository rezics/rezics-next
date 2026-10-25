import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

/** Tokenize declaration imports without treating comments or string literal types as code. */
function declarationSpecifiers(content: string): string[] {
  const tokens = [
    ...content.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|[^\s]/g),
  ]
    .map((match) => match[0])
    .filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
  const specifiers: string[] = [];
  const literal = (token: string | undefined) => token?.startsWith("'") || token?.startsWith('"');
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let target: string | undefined;
    if (token === 'from' || token === 'import') {
      if (literal(tokens[index + 1])) target = tokens[index + 1];
    }
    if ((token === 'import' || token === 'require') && tokens[index + 1] === '(' && literal(tokens[index + 2]))
      target = tokens[index + 2];
    if (target) specifiers.push(target.slice(1, -1));
  }
  return specifiers;
}

/** Service source must never become a client's transitive compiler input. */
export function assertNoServiceImports(declarations: Map<string, string>, root = ROOT): void {
  const services = new Set<string>();
  for (const entry of readdirSync(resolve(root, 'services'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = resolve(root, 'services', entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
    if (name) services.add(name);
  }
  for (const [file, content] of declarations) {
    for (const specifier of declarationSpecifiers(content)) {
      const bare = specifier.split(/[?#]/)[0]!;
      const packageName = bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0]!;
      if (services.has(packageName))
        throw new Error(`Client declaration ${file} imports service package ${packageName}`);
    }
  }
}

/** TypeScript 7 writes a content-mapped `.sql` module as `name.d.sql.ts`. Resolution also accepts `name.sql.d.ts`, which is the name this closure walks. */
function publishSqlDeclarations(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      publishSqlDeclarations(path);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.d.sql.ts')) continue;
    const stem = entry.name.slice(0, -'.d.sql.ts'.length);
    renameSync(path, resolve(directory, `${stem}.sql.d.ts`));
  }
}

function declarationPath(sourcePath: string, specifier: string): string {
  const path = resolve(dirname(sourcePath), specifier);
  if (path.endsWith('.ts')) return `${path.slice(0, -3)}.d.ts`;
  if (path.endsWith('.js')) return `${path.slice(0, -3)}.d.ts`;
  if (path.endsWith('.d.ts')) return path;
  return `${path}.d.ts`;
}

export function clientDeclarations(kernelDirectory = KERNEL): Map<string, string> {
  const temporaryRoot = resolve(ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const temporaryDirectory = mkdtempSync(resolve(temporaryRoot, 'kernel-client-'));
  try {
    const compiler = resolve(ROOT, 'node_modules/.bin/tsc');
    const compilerConfig = resolve(temporaryDirectory, 'tsconfig.json');
    const modules = resolve(kernelDirectory, 'node_modules');
    if (existsSync(modules)) symlinkSync(modules, resolve(temporaryDirectory, 'node_modules'), 'dir');
    writeFileSync(
      compilerConfig,
      JSON.stringify({
        extends: resolve(kernelDirectory, 'tsconfig.json'),
        compilerOptions: {
          rootDir: kernelDirectory,
          outDir: temporaryDirectory,
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
        },
        include: [resolve(kernelDirectory, 'src')],
      }),
    );
    const result = spawnSync(compiler, ['-p', compilerConfig, '--runExternalCode'], {
      cwd: kernelDirectory,
      env: process.env,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);

    const sourceRoot = resolve(temporaryDirectory, 'src');
    publishSqlDeclarations(sourceRoot);
    const pending = ['http/kernel.d.ts', 'http/request.d.ts'];
    const declarations = new Map<string, string>();
    while (pending.length) {
      const key = pending.pop()!;
      if (declarations.has(key)) continue;
      const sourcePath = resolve(sourceRoot, key);
      const content = readFileSync(sourcePath, 'utf8');
      declarations.set(key, content);
      for (const specifier of declarationSpecifiers(content).filter((value) => /^\.{1,2}\//.test(value))) {
        const target = declarationPath(sourcePath, specifier);
        const targetKey = relative(sourceRoot, target).split(sep).join('/');
        if (!targetKey.startsWith('../') && !declarations.has(targetKey)) pending.push(targetKey);
      }
    }
    assertNoServiceImports(declarations, resolve(kernelDirectory, '../..'));
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
