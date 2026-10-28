import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const temporary = mkdtempSync(join(tmpdir(), 'rezics-web-check-'));
const checkout = join(temporary, 'worktree');
const checkTimeout = 12 * 60 * 60 * 1000;

async function run(args: string[], cwd = root, timeout = checkTimeout) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  try {
    const [code, [stdout, stderr]] = await Promise.all([child.exited, output]);
    return { code, output: `${stdout}\n${stderr}` };
  } finally {
    clearTimeout(timer);
  }
}

afterAll(() => {
  if (statSync(temporary, { throwIfNoEntry: false })) {
    Bun.spawnSync(['git', 'worktree', 'remove', '--force', checkout], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test(
  'a fresh worktree prepares generated sources, Worker credentials and browser dependencies before its selected browser test',
  async () => {
    const added = await run(['git', 'worktree', 'add', '--detach', checkout, 'HEAD']);
    expect(added.code, added.output).toBe(0);

    const installed = await run(['bun', 'install'], checkout);
    expect(installed.code, installed.output).toBe(0);

    const app = join(checkout, 'apps/web');
    expect(Bun.file(join(app, 'src/paraglide/messages.js')).exists()).resolves.toBe(false);
    expect(Bun.file(join(app, 'src/routeTree.gen.ts')).exists()).resolves.toBe(false);
    expect(Bun.file(join(app, 'node_modules/.vite')).exists()).resolves.toBe(false);
    expect(Bun.file(join(app, '.dev.vars')).exists()).resolves.toBe(false);

    const checked = await run(['bun', 'run', '--cwd', 'apps/web', 'check', 'tests/dev-dependencies.test.ts'], checkout);
    expect(checked.code, checked.output).toBe(0);

    expect(Bun.file(join(app, 'src/paraglide/messages.js')).exists()).resolves.toBe(true);
    expect(Bun.file(join(app, 'src/routeTree.gen.ts')).exists()).resolves.toBe(true);
    expect(checked.output).not.toMatch(/optimized dependencies changed\. reloading/i);
    const example = readFileSync(join(app, '.dev.vars.example'), 'utf8');
    const installedVars = readFileSync(join(app, '.dev.vars'), 'utf8');
    expect(installedVars).toBe(example);
    const values = Object.fromEntries(
      installedVars
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const split = line.indexOf('=');
          return [line.slice(0, split), line.slice(split + 1)];
        }),
    );
    const key = JSON.parse(values.WEBSITE_CLIENT_KEY ?? 'null') as Record<string, string>;
    expect(key.kid).toMatch(/test/i);
    expect(key.kty).toBe('EC');
    expect(key.crv).toBe('P-256');
    expect(key.d).toBeTruthy();
    expect(key.alg).toBe('ES256');
    expect((await run(['git', 'check-ignore', '-q', 'apps/web/.dev.vars'], checkout)).code).toBe(0);

    const before = 'WEBSITE_CLIENT_KEY=preserve-this-local-secret\n';
    await Bun.write(join(app, '.dev.vars'), before);
    const second = await run(['bun', 'scripts/check.ts', '--prepare-only'], app);
    expect(second.code, second.output).toBe(0);
    expect(readFileSync(join(app, '.dev.vars'), 'utf8')).toBe(before);
  },
  checkTimeout + 60_000,
);
