import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { transpileLandingCandidate } from './landing-transpile.ts';
import { temporaryDirectory } from './test-support.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

test('the real Bun command compiles supported unbundled entry points and safely skips deleted, declarations and non-TypeScript changes', async () => {
  const fixture = temporaryDirectory();
  try {
    const root = fixture.path;
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(root, '.gitignore'), '.temp/\n');
    const files = [
      ['src/value $; quoted.ts', "import { dependency } from './not-installed';\nexport const value = dependency;\n"],
      ['src/view.tsx', 'export const View = () => <div />;\n'],
      ['src/module.mts', 'export const moduleValue = 3;\n'],
      ['src/legacy-module.cts', 'export const legacyModuleValue = 4;\n'],
      ['src/types.d.ts', 'export declare const typeOnly: string;\n'],
      ['src/readme.js', 'export const javascript = true;\n'],
      ['src/deleted.ts', 'export const deleted = true;\n'],
    ] as const;
    for (const [path, content] of files) put(root, path, content);
    git(root, 'add', '--', ...files.map(([path]) => path));
    git(root, 'commit', '-m', 'Seed compiler fixture');
    const base = git(root, 'rev-parse', 'HEAD');
    unlinkSync(join(root, 'src/deleted.ts'));
    const trackedContents = new Map(files.filter(([path]) => path !== 'src/deleted.ts').map(([path]) => [path, readFileSync(join(root, path), 'utf8')]));
    const staged = git(root, 'diff', '--cached', '--binary');
    const changedFiles = files.map(([path]) => path);
    const logPath = join(root, '.temp', 'diagnostics.log');
    const result = await transpileLandingCandidate({
      cwd: root,
      base,
      candidate: base,
      changedFiles,
      logPath,
    });
    const sourceBytes = files
      .slice(0, 4)
      .reduce((total, [path]) => total + Buffer.byteLength(readFileSync(join(root, path))), 0);
    console.log(
      `landing-transpile fixture: ${result.elapsedMs}ms; changedFiles=${result.changedFileCount}; executableTypeScriptFiles=${result.typescriptFileCount}; representativeSourceBytes=${sourceBytes}`,
    );
    expect(result).toMatchObject({ outcome: 'passed', changedFileCount: 7, typescriptFileCount: 4 });
    expect(result.elapsedMs).toEqual(expect.any(Number));
    expect(result.typescriptFiles).toEqual(files.slice(0, 4).map(([path]) => path));
    expect(readFileSync(logPath, 'utf8')).toContain('Dev landing transpile passed');
    expect(readdirSync(join(root, '.temp'))).toEqual(['diagnostics.log']);
    for (const [path, content] of trackedContents) expect(readFileSync(join(root, path), 'utf8')).toBe(content);
    expect(git(root, 'diff', '--cached', '--binary')).toBe(staged);
    expect(git(root, 'status', '--porcelain')).toContain('D src/deleted.ts');
    expect(resolve(result.logPath)).toBe(result.logPath);
  } finally {
    fixture.close();
  }
});

test('the actual Bun command returns const-reassignment and syntax diagnostics with absolute file and line', async () => {
  const fixture = temporaryDirectory();
  try {
    const root = fixture.path;
    const base = 'fixture-base';
    const logPath = join(root, '.temp', 'compiler.log');
    const cases = [
      ['src/const-error.ts', 'const count = 1;\ncount = 2;\nexport { count };\n', 2],
      ['src/syntax-error.ts', 'export const value = (\n', 1],
    ] as const;
    for (const [path, content, expectedLine] of cases) {
      put(root, path, content);
      const result = await transpileLandingCandidate({
        cwd: root,
        base,
        candidate: 'candidate-sha',
        changedFiles: [path],
        logPath,
      });
      expect(result.outcome).toBe('diagnostic');
      expect(result.diagnostic?.file).toBe(join(root, path));
      expect(result.diagnostic?.line).toBe(expectedLine);
      expect(result.diagnostic?.message.length).toBeGreaterThan(0);
      expect(result.logPath).toBe(logPath);
      expect(readFileSync(logPath, 'utf8')).toContain(`${join(root, path)}:${expectedLine}:`);
      expect(readdirSync(join(root, '.temp'))).toEqual(['compiler.log']);
    }
  } finally {
    fixture.close();
  }
});

test('deleted, declaration-only and non-TypeScript deltas skip without a compiler run', async () => {
  const fixture = temporaryDirectory();
  try {
    const root = fixture.path;
    put(root, 'types.d.ts', 'export declare const value: string;\n');
    const result = await transpileLandingCandidate({
      cwd: root,
      base: 'base',
      candidate: 'candidate',
      changedFiles: ['deleted.ts', 'types.d.ts', 'image.png'],
      logPath: join(root, '.temp', 'skip.log'),
    });
    expect(result).toMatchObject({ outcome: 'skipped', changedFileCount: 3, typescriptFileCount: 0, elapsedMs: null });
    expect(result.logPath).toBe(join(root, '.temp', 'skip.log'));
  } finally {
    fixture.close();
  }
});
