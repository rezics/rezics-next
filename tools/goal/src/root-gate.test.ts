import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { temporaryDirectory } from './test-support.ts';

const gateScript = resolve(import.meta.dir, '../../../scripts/gate.ts');

async function fixture(options: { failing?: string } = {}) {
  const temporary = temporaryDirectory();
  const root = temporary.path;
  const workspaces = [
    { directory: 'apps/alpha', name: '@fixture/alpha', delay: options.failing === '@fixture/alpha' ? 1800 : 2000 },
    { directory: 'packages/beta', name: '@fixture/beta', delay: options.failing === '@fixture/beta' ? 1800 : 2000 },
    { directory: 'services/gamma', name: '@fixture/gamma', delay: options.failing === '@fixture/gamma' ? 1800 : 2000 },
  ];

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'root-gate-fixture',
        private: true,
        workspaces: ['apps/*', 'services/*', 'packages/*'],
      },
      null,
      2,
    ),
  );

  for (const workspace of workspaces) {
    const directory = join(root, workspace.directory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify(
        {
          name: workspace.name,
          scripts: { check: 'bun check.ts' },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(directory, 'check.ts'),
      `
      import { writeFileSync } from 'node:fs';
      await Bun.sleep(${workspace.delay});
      console.log('check-output-${workspace.name}');
      writeFileSync(new URL('./finished', import.meta.url), 'finished');
      ${options.failing === workspace.name ? 'process.exit(1);' : ''}
    `,
    );
  }

  const install = Bun.spawn([process.execPath, 'install'], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [installCode, installStdout, installStderr] = await Promise.all([
    install.exited,
    new Response(install.stdout).text(),
    new Response(install.stderr).text(),
  ]);
  expect(installCode, installStdout + installStderr).toBe(0);

  const ownGate = join(root, 'tools/goal/scripts');
  mkdirSync(ownGate, { recursive: true });
  writeFileSync(join(ownGate, 'gate.ts'), "console.log('control-plane-gate-output');\n");

  return {
    root,
    workspaces,
    close: temporary.close,
  };
}

async function runGate(root: string) {
  const env = { ...process.env };
  delete env.GATE_CONCURRENCY;
  const startedAt = performance.now();
  const child = Bun.spawn([process.execPath, gateScript], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr, durationMs: performance.now() - startedAt };
}

test('the root gate runs workspace checks concurrently so its time follows the slowest workspace', async () => {
  const h = await fixture();
  try {
    const result = await runGate(h.root);

    expect(result.code).toBe(0);
    expect(result.durationMs).toBeLessThan(5000);
    expect(result.output).toContain('control-plane-gate-output');
    for (const workspace of h.workspaces) {
      expect(readFileSync(join(h.root, workspace.directory, 'finished'), 'utf8')).toBe('finished');
      expect(result.output).toContain(`check-output-${workspace.name}`);
      expect(result.output).toContain(workspace.name);
    }
  } finally {
    h.close();
  }
}, 15_000);

test('a failing workspace fails after all workspaces finish and prints its output last', async () => {
  const failingWorkspace = '@fixture/alpha';
  const h = await fixture({ failing: failingWorkspace });
  try {
    const result = await runGate(h.root);

    expect(result.code).not.toBe(0);
    expect(result.durationMs).toBeGreaterThan(1500);
    expect(result.output).not.toContain('control-plane-gate-output');
    for (const workspace of h.workspaces) {
      expect(readFileSync(join(h.root, workspace.directory, 'finished'), 'utf8')).toBe('finished');
      expect(result.output).toContain(`check-output-${workspace.name}`);
    }
    expect(result.output.indexOf(`check-output-${failingWorkspace}`)).toBeGreaterThan(
      Math.max(
        ...h.workspaces
          .filter((workspace) => workspace.name !== failingWorkspace)
          .map((workspace) => result.output.indexOf(`check-output-${workspace.name}`)),
      ),
    );
  } finally {
    h.close();
  }
}, 15_000);
