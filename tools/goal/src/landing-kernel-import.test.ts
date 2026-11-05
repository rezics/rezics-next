import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { importLandingKernelCandidate } from './landing-kernel-import.ts';
import { transpileLandingCandidate } from './landing-transpile.ts';
import { temporaryDirectory } from './test-support.ts';

const STUB_DATABASE =
  "export async function withThrowawayDatabase(work) { return work({ ...process.env, DATABASE_URL: 'postgres://rezics:rezics@127.0.0.1:59999/rezics?sslmode=disable', KERNEL_DATABASE_CONTAINER: 'fixture' }); }\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function kernelFixture(source: { server: string; worker: string; extra?: Record<string, string> }) {
  const fixture = temporaryDirectory();
  const root = fixture.path;
  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  put(root, '.gitignore', '.temp/\n');
  put(root, 'services/kernel/scripts/derived.ts', STUB_DATABASE);
  put(root, 'services/kernel/src/server.ts', source.server);
  put(root, 'services/kernel/src/worker.ts', source.worker);
  for (const [path, content] of Object.entries(source.extra ?? {})) put(root, path, content);
  git(root, 'add', '--', '.');
  git(root, 'commit', '-m', 'Seed kernel import fixture');
  return { root, close: fixture.close };
}

async function runImport(root: string, changedFiles: readonly string[]) {
  mkdirSync(join(root, '.temp'), { recursive: true });
  return importLandingKernelCandidate({
    cwd: root,
    base: 'base',
    candidate: 'candidate',
    changedFiles,
    logPath: join(root, '.temp', 'landing.log'),
  });
}

test('a candidate that does not change Kernel source skips database provisioning and entry imports', async () => {
  const fixture = kernelFixture({
    server: 'export const server = true;\n',
    worker: 'export const worker = true;\n',
  });
  try {
    const result = await runImport(fixture.root, ['packages/fixture/value.ts']);
    expect(result).toMatchObject({ outcome: 'skipped', kernelFileCount: 0, elapsedMs: null, setupMs: null });
    expect(existsSync(join(fixture.root, '.temp', 'landing.log'))).toBe(false);
  } finally {
    fixture.close();
  }
});

test('a TDZ value-import cycle missed by unbundled transpile returns the first diagnostic and retains the log', async () => {
  const extra = {
    'services/kernel/src/cycle-a.ts': "import { b } from './cycle-b.ts';\nexport const a = b + 1;\n",
    'services/kernel/src/cycle-b.ts': "import { a } from './cycle-a.ts';\nexport const b = a + 1;\n",
  };
  const fixture = kernelFixture({
    server: "import { a } from './cycle-a.ts';\nexport const server = a;\n",
    worker: "import { b } from './cycle-b.ts';\nexport const worker = b;\n",
    extra,
  });
  try {
    const { root } = fixture;
    const changed = [
      'services/kernel/src/server.ts',
      'services/kernel/src/worker.ts',
      'services/kernel/src/cycle-a.ts',
      'services/kernel/src/cycle-b.ts',
    ];
    const transpiled = await transpileLandingCandidate({
      cwd: root,
      base: 'base',
      candidate: 'candidate',
      changedFiles: changed,
      logPath: join(root, '.temp', 'transpile.log'),
    });
    expect(transpiled.outcome).toBe('passed');
    const result = await runImport(root, changed);
    expect(result.outcome).toBe('diagnostic');
    expect(result.diagnostic?.message).toMatch(/before initialization|Cannot access/i);
    expect(result.diagnostic?.entry).toMatch(/server\.ts|worker\.ts/);
    expect(result.logPath).toBe(join(root, '.temp', 'landing.log'));
    expect(existsSync(result.logPath)).toBe(true);
    expect(readFileSync(result.logPath, 'utf8')).toContain('Dev landing Kernel import diagnostic:');
    expect(readdirSync(join(root, '.temp')).every((name) => !name.startsWith('dev-kernel-import-'))).toBe(true);
  } finally {
    fixture.close();
  }
});

test('successful imports evaluate both entries with the throwaway DATABASE_URL before module load', async () => {
  const probe = 'KERNEL_IMPORT_PROBE';
  const writer = (entry: string) =>
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(process.env.${probe}!, JSON.stringify({ entry: '${entry}', url: process.env.DATABASE_URL, pid: process.pid, main: import.meta.main }) + '\\n');`,
      `export const ${entry} = true;`,
      "if (import.meta.main) console.log('started');\n",
    ].join('\n');
  const fixture = kernelFixture({ server: writer('server'), worker: writer('worker') });
  try {
    const { root } = fixture;
    const probePath = join(root, '.temp', 'probe.jsonl');
    mkdirSync(join(root, '.temp'), { recursive: true });
    process.env[probe] = probePath;
    const result = await runImport(root, ['services/kernel/src/server.ts']);
    expect(result.outcome).toBe('passed');
    expect(result.setupMs).toEqual(expect.any(Number));
    expect(result.importMs).toEqual(expect.any(Number));
    expect(result.cleanupMs).toEqual(expect.any(Number));
    const rows = readFileSync(probePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { entry: string; url: string; pid: number; main: boolean });
    expect(rows.map((row) => row.entry).sort()).toEqual(['server', 'worker']);
    expect(new Set(rows.map((row) => row.pid)).size).toBe(2);
    expect(rows.every((row) => row.main === false)).toBe(true);
    expect(rows.every((row) => row.url.includes('127.0.0.1:59999'))).toBe(true);
    expect(readFileSync(join(root, '.temp', 'landing.log'), 'utf8')).not.toContain('started');
  } finally {
    delete process.env[probe];
    fixture.close();
  }
});

test('interrupting the import removes owned driver files and keeps the diagnostic log', async () => {
  const fixture = kernelFixture({
    server: 'export const server = true;\n',
    worker: 'export const worker = true;\n',
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const { root } = fixture;
    put(
      root,
      'services/kernel/scripts/derived.ts',
      [
        "import { writeFileSync } from 'node:fs';",
        'export async function withThrowawayDatabase(work) {',
        "  writeFileSync(process.env.KERNEL_IMPORT_READY!, String(process.pid));",
        '  await new Promise(() => {});',
        '  return work(process.env);',
        '}\n',
      ].join('\n'),
    );
    const ready = join(root, '.temp', 'ready');
    mkdirSync(join(root, '.temp'), { recursive: true });
    const script = `
      import { importLandingKernelCandidate } from ${JSON.stringify(join(import.meta.dir, 'landing-kernel-import.ts'))};
      await importLandingKernelCandidate({
        cwd: ${JSON.stringify(root)},
        base: 'base',
        candidate: 'candidate',
        changedFiles: ['services/kernel/src/server.ts'],
        logPath: ${JSON.stringify(join(root, '.temp', 'landing.log'))},
      });
    `;
    const childEnv: NodeJS.ProcessEnv = { ...process.env, KERNEL_IMPORT_READY: ready };
    delete childEnv.DATABASE_URL;
    delete childEnv.KERNEL_DATABASE_CONTAINER;
    child = spawn(process.execPath, ['-e', script], {
      cwd: root,
      env: childEnv,
      stdio: 'ignore',
    });
    const started = Date.now();
    while (!existsSync(ready) && Date.now() - started < 10_000) await Bun.sleep(50);
    expect(existsSync(ready)).toBe(true);
    process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
    await new Promise<void>((resolveClose) => child!.once('close', () => resolveClose()));
    expect(existsSync(join(root, '.temp', 'landing.log'))).toBe(true);
    expect(readdirSync(join(root, '.temp')).every((name) => !name.startsWith('dev-kernel-import-'))).toBe(true);
  } finally {
    child?.kill('SIGKILL');
    fixture.close();
  }
}, 20_000);

test('a real Reylo SQL mismatch against candidate migrations returns the first diagnostic', async () => {
  const repository = resolveRepository();
  const fixture = temporaryDirectory();
  try {
    const root = fixture.path;
    git(root, 'init', '-b', 'dev');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    put(root, '.gitignore', '.temp/\n');
    put(
      root,
      'services/kernel/scripts/derived.ts',
      `export { withThrowawayDatabase } from ${JSON.stringify(join(repository, 'services/kernel/scripts/derived.ts'))};\n`,
    );
    put(root, 'services/kernel/src/mismatch.sql', 'SELECT missing_query_key FROM semantic.subject;\n');
    put(root, 'services/kernel/src/server.ts', "import mismatch from './mismatch.sql';\nexport { mismatch };\n");
    put(root, 'services/kernel/src/worker.ts', "export const worker = true;\n");
    symlinkIfPresent(join(repository, 'node_modules'), join(root, 'node_modules'));
    symlinkIfPresent(join(repository, 'services/kernel/node_modules'), join(root, 'services/kernel/node_modules'));
    const result = await runImport(root, ['services/kernel/src/server.ts', 'services/kernel/src/mismatch.sql']);
    expect(['diagnostic', 'unavailable']).toContain(result.outcome);
    if (result.outcome === 'unavailable') {
      expect(result.infrastructureError).toBeTruthy();
      return;
    }
    expect(result.diagnostic?.message.length).toBeGreaterThan(0);
    expect(result.diagnostic?.entry).toBe('services/kernel/src/server.ts');
    expect(existsSync(result.logPath)).toBe(true);
  } finally {
    fixture.close();
  }
}, 180_000);

test('importing the actual Kernel server and worker against a throwaway database measures setup, import and cleanup', async () => {
  const root = resolveRepository();
  const logPath = join(root, '.temp', 'kernel-import-acceptance.log');
  mkdirSync(join(root, '.temp'), { recursive: true });
  const result = await importLandingKernelCandidate({
    cwd: root,
    base: 'base',
    candidate: 'candidate',
    changedFiles: ['services/kernel/src/server.ts'],
    logPath,
  });
  console.log(
    `landing-kernel-import fixture: outcome=${result.outcome} setup=${result.setupMs}ms import=${result.importMs}ms cleanup=${result.cleanupMs}ms total=${result.elapsedMs}ms`,
  );
  expect(['passed', 'unavailable']).toContain(result.outcome);
  if (result.outcome === 'unavailable') {
    expect(result.infrastructureError).toBeTruthy();
    expect(result.elapsedMs).toBeNull();
    return;
  }
  expect(result.setupMs).toEqual(expect.any(Number));
  expect(result.importMs).toEqual(expect.any(Number));
  expect(result.cleanupMs).toEqual(expect.any(Number));
  expect(readFileSync(logPath, 'utf8')).toContain('kernel-import entry=');
}, 360_000);

function resolveRepository(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dir, encoding: 'utf8' }).trim();
}

function symlinkIfPresent(target: string, path: string): void {
  if (!existsSync(target) || existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  execFileSync('ln', ['-s', target, path]);
}
