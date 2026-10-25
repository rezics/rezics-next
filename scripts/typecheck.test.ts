import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { typecheck, type StartedDatabase } from './typecheck.ts';

function fixture(): { root: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'rezics-typecheck-'));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

function writeWorkspace(
  root: string,
  directory: string,
  name: string,
  typecheckScript: string | undefined,
  files: Record<string, string> = {},
): void {
  const workspace = join(root, directory);
  mkdirSync(workspace, { recursive: true });
  const manifest: { name: string; scripts?: { typecheck: string } } = { name };
  if (typecheckScript !== undefined) manifest.scripts = { typecheck: typecheckScript };
  writeFileSync(join(workspace, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(workspace, file), content);
}

function collector(): { stdout: { write(chunk: string): void }; text(): string } {
  let text = '';
  return {
    stdout: {
      write(chunk: string) {
        text += chunk;
      },
    },
    text: () => text,
  };
}

function unusedDatabase(): () => Promise<StartedDatabase> {
  return async () => ({ url: 'postgres://typecheck/unused', remove() {} });
}

const passScript = 'await Bun.write("typechecked", "ok")\n';

test("every workspace's typecheck runs and the run passes when all pass", async () => {
  const { root, remove } = fixture();
  try {
    for (const [directory, name] of [
      ['apps/web', '@fixture/app'],
      ['services/kernel', '@fixture/kernel'],
      ['packages/filter', '@fixture/filter'],
    ] as const) {
      writeWorkspace(root, directory, name, 'bun pass.ts', { 'pass.ts': passScript });
    }
    writeWorkspace(root, 'tools/goal', '@fixture/tools', 'bun decoy.ts', {
      'decoy.ts': 'await Bun.write("ran", "tools")\nprocess.exit(1)\n',
    });
    writeWorkspace(root, 'packages/filter/nested', '@fixture/nested', 'bun decoy.ts', {
      'decoy.ts': 'process.exit(1)\n',
    });
    writeWorkspace(root, 'other/stray', '@fixture/stray', 'bun decoy.ts', { 'decoy.ts': 'process.exit(1)\n' });
    const output = collector();

    const code = await typecheck({ root, startDatabase: unusedDatabase(), stdout: output.stdout });

    expect(code).toBe(0);
    for (const directory of ['apps/web', 'services/kernel', 'packages/filter']) {
      expect(existsSync(join(root, directory, 'typechecked'))).toBe(true);
    }
    expect(existsSync(join(root, 'tools/goal/ran'))).toBe(false);
    const text = output.text();
    for (const name of ['@fixture/app', '@fixture/kernel', '@fixture/filter']) {
      expect(text).toMatch(new RegExp(`Workspace ${name} finished in \\d+\\.\\d{2}s`));
    }
    expect(text).not.toContain('@fixture/tools');
    expect(text).not.toContain('@fixture/nested');
    expect(text).not.toContain('@fixture/stray');
  } finally {
    remove();
  }
});

test('a failing workspace fails the run and its output is printed under its name', async () => {
  const { root, remove } = fixture();
  try {
    writeWorkspace(root, 'packages/ok', '@fixture/passing', 'bun pass.ts', {
      'pass.ts': 'console.log("passing workspace output")\nawait Bun.write("typechecked", "ok")\n',
    });
    writeWorkspace(root, 'services/bad', '@fixture/failing', 'bun fail.ts', {
      'fail.ts':
        'console.log("type error in widget.ts(1,1): error TS2322: bad")\nconsole.log("  Type X is not assignable")\nprocess.exit(1)\n',
    });
    const output = collector();

    const code = await typecheck({ root, startDatabase: unusedDatabase(), stdout: output.stdout });

    const text = output.text();
    const passing = text.indexOf('Workspace @fixture/passing ');
    const failing = text.indexOf('Workspace @fixture/failing ');
    const diagnostic = text.indexOf('type error in widget.ts(1,1): error TS2322: bad');
    expect(code).toBe(1);
    expect(existsSync(join(root, 'packages/ok/typechecked'))).toBe(true);
    expect(passing).toBeGreaterThanOrEqual(0);
    expect(failing).toBeGreaterThan(passing);
    expect(diagnostic).toBeGreaterThan(failing);
    expect(text.indexOf('  Type X is not assignable')).toBeGreaterThan(diagnostic);
    expect(text).not.toContain('passing workspace output');
    expect(text).toMatch(/Workspace @fixture\/failing finished in \d+\.\d{2}s/);
  } finally {
    remove();
  }
});

test('a workspace without a typecheck script falls back to tsc on its tsconfig', async () => {
  const { root, remove } = fixture();
  try {
    const record = join(root, 'tsc-invocations.jsonl');
    installTsc(root, record);
    writeWorkspace(root, 'packages/plain', '@fixture/plain', undefined, {
      'tsconfig.json': '{ "files": [] }\n',
    });
    writeWorkspace(root, 'apps/scripted', '@fixture/scripted', 'bun pass.ts', { 'pass.ts': passScript });
    const output = collector();

    const code = await typecheck({ root, startDatabase: unusedDatabase(), stdout: output.stdout });

    expect(code).toBe(0);
    expect(existsSync(join(root, 'apps/scripted/typechecked'))).toBe(true);
    const invocations = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { cwd: string; argv: string[] });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.cwd).toBe(join(root, 'packages/plain'));
    expect(invocations[0]?.argv.filter((arg) => arg.startsWith('-') || arg === 'tsconfig.json')).toEqual([
      '--noEmit',
      '-p',
      'tsconfig.json',
    ]);
    expect(output.text()).toMatch(/Workspace @fixture\/plain finished in \d+\.\d{2}s/);
    expect(output.text()).toContain('node_modules/.bin/tsc --noEmit -p tsconfig.json');
  } finally {
    remove();
  }
});

test('workspaces that need a database receive DATABASE_URL and the database is removed afterwards', async () => {
  const { root, remove } = fixture();
  try {
    const url = 'postgres://typecheck/needed';
    const gone = join(root, 'db-gone');
    const record = join(root, 'tsc-invocations.jsonl');
    let starts = 0;
    let removals = 0;
    installTsc(root, record, gone);
    const recordDatabase = `import { existsSync } from 'node:fs';
if (existsSync(${JSON.stringify(gone)})) {
  console.error('removed too early');
  process.exit(1);
}
const url = process.env.DATABASE_URL ?? '';
if (!url) process.exit(1);
await Bun.write('database-url', url);
`;
    writeWorkspace(root, 'services/kernel', '@fixture/kernel', 'bun record.ts', { 'record.ts': recordDatabase });
    writeWorkspace(root, 'services/auth', '@fixture/auth', 'bun record.ts', { 'record.ts': recordDatabase });
    writeWorkspace(root, 'packages/client', '@fixture/client', undefined, { 'tsconfig.json': '{ "files": [] }\n' });
    const output = collector();

    const code = await typecheck({
      root,
      stdout: output.stdout,
      startDatabase: async () => {
        starts += 1;
        return {
          url,
          remove() {
            removals += 1;
            writeFileSync(gone, 'gone');
          },
        };
      },
    });

    expect(code).toBe(0);
    expect(starts).toBe(1);
    expect(removals).toBe(1);
    expect(existsSync(gone)).toBe(true);
    expect(readFileSync(join(root, 'services/kernel/database-url'), 'utf8')).toBe(url);
    expect(readFileSync(join(root, 'services/auth/database-url'), 'utf8')).toBe(url);
    const invocations = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { cwd: string; argv: string[]; databaseUrl: string });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.cwd).toBe(join(root, 'packages/client'));
    expect(invocations[0]?.databaseUrl).toBe(url);
    expect(output.text()).toContain('@fixture/kernel');
    expect(output.text()).toContain('@fixture/auth');
  } finally {
    remove();
  }
});

function installTsc(root: string, record: string, gone?: string): void {
  const bin = join(root, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  const guard = gone ? `if (existsSync(${JSON.stringify(gone)})) process.exit(1);\n` : '';
  writeFileSync(
    join(bin, 'tsc'),
    `#!/usr/bin/env bun
import { appendFileSync, existsSync } from 'node:fs';
${guard}appendFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv, databaseUrl: process.env.DATABASE_URL ?? '' }) + '\\n');
`,
  );
  chmodSync(join(bin, 'tsc'), 0o755);
}
