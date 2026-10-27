import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '..');
const directories: string[] = [];
type Run = {
  child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  output: { stdout: string; stderr: string };
  done: Promise<void[]>;
};
const runs: Run[] = [];

function startRootTest(area: 'specs' | 'scripts'): { run: Run; directory: string; marker: string } {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/stack-lease-preload-test-'));
  directories.push(directory);
  const testDirectory = join(directory, area);
  mkdirSync(testDirectory, { recursive: true });
  const marker = join(directory, 'environment');
  const fixture = join(testDirectory, 'fixture.test.ts');
  writeFileSync(
    fixture,
    `import { test } from 'bun:test';\n` +
      `import { writeFileSync } from 'node:fs';\n` +
      `test('fixture stays alive for the process lifetime check', async () => {\n` +
      `  writeFileSync(${JSON.stringify(marker)}, process.env.REZICS_STACK_SLOT ?? '');\n` +
      `  await Bun.stdin.text();\n` +
      `});\n`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REZICS_STACK_LEASE_DIR: join(directory, 'lease'),
    REZICS_STACK_SLOTS: '1',
  };
  delete env.REZICS_STACK_SLOT;
  delete env.REZICS_STACK_LEASE;
  // The fixture reads the slot of this machine's lease. An empty KERNEL_CHECK_REMOTE falls back to the shared hosts
  // file, so a missing file is what keeps the fixture here.
  env.KERNEL_CHECK_REMOTE = join(directory, 'no-such-hosts.json');
  const child = Bun.spawn([process.execPath, 'test', fixture], {
    cwd: repository,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = { stdout: '', stderr: '' };
  const drain = async (stream: ReadableStream<Uint8Array>, key: 'stdout' | 'stderr') => {
    for await (const chunk of stream) output[key] += new TextDecoder().decode(chunk);
  };
  const done = Promise.all([drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr')]);
  const run = { child, output, done };
  runs.push(run);
  return { run, directory, marker };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

function slotIsHeld(directory: string): boolean {
  return Bun.spawnSync(['flock', '-n', '-E', '75', join(directory, 'lease/slot-1.lock'), 'true']).exitCode === 75;
}

afterEach(async () => {
  for (const run of runs.splice(0)) {
    await run.child.stdin.end();
    if (run.child.exitCode === null) run.child.kill('SIGTERM');
    await run.child.exited;
    await run.done;
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('a root test run that includes specs holds one slot for its process', async () => {
  const { run, directory, marker } = startRootTest('specs');
  await waitFor(() => existsSync(marker));
  expect(readFileSync(marker, 'utf8')).toBe('1/1');
  expect(slotIsHeld(directory)).toBe(true);

  await run.child.stdin.end();
  expect(await run.child.exited).toBe(0);
  await run.done;
  expect(slotIsHeld(directory)).toBe(false);
});

test('a root test run without specs takes no slot', async () => {
  const { run, directory, marker } = startRootTest('scripts');
  await waitFor(() => existsSync(marker));
  expect(readFileSync(marker, 'utf8')).toBe('');
  expect(slotIsHeld(directory)).toBe(false);

  await run.child.stdin.end();
  expect(await run.child.exited).toBe(0);
  await run.done;
  expect(slotIsHeld(directory)).toBe(false);
});
