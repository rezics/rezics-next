import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '..');
const directories: string[] = [];
const heldSlots: Bun.Subprocess<'pipe', 'ignore', 'ignore'>[] = [];
type Run = {
  child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  output: { stdout: string; stderr: string };
  done: Promise<void[]>;
};
const runs: Run[] = [];

type RootTestOptions = { routeToCheckHost?: boolean; holdLocalSlot?: boolean };

async function startRootTest(
  area: 'specs' | 'scripts',
  options: RootTestOptions = {},
): Promise<{
  run: Run;
  directory: string;
  marker: string;
  goalMarker: string;
  waitFile: string;
  holder?: Bun.Subprocess<'pipe', 'ignore', 'ignore'>;
}> {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/stack-lease-preload-test-'));
  directories.push(directory);
  const testDirectory = join(directory, area);
  mkdirSync(testDirectory, { recursive: true });
  const marker = join(directory, 'environment');
  const goalMarker = join(directory, 'goal-environment');
  const waitFile = join(directory, 'attempt-waits');
  const fixture = join(testDirectory, 'fixture.test.ts');
  writeFileSync(
    fixture,
    `import { test } from 'bun:test';\n` +
      `import { writeFileSync } from 'node:fs';\n` +
      `test('fixture stays alive for the process lifetime check', async () => {\n` +
      `  writeFileSync(${JSON.stringify(goalMarker)}, JSON.stringify(\n` +
      `    Object.keys(process.env).filter((key) => key.startsWith('GOAL_')),\n` +
      `  ));\n` +
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
  env.GOAL_CHECK_WAIT_FILE = waitFile;
  env.GOAL_TEST_SENTINEL = 'must be hidden from the fixture';
  if (options.routeToCheckHost) {
    const fakeDirectory = join(directory, 'fake-check-host');
    const bin = join(fakeDirectory, 'bin');
    mkdirSync(bin, { recursive: true });
    const ssh = join(bin, 'ssh');
    writeFileSync(
      ssh,
      `#!/usr/bin/env bun\n` +
        `import { existsSync } from 'node:fs';\n` +
        `const script = process.argv.at(-1) ?? '';\n` +
        `const state = process.env.FAKE_CHECK_HOST_DIR!;\n` +
        `if (script.includes('PROCESSORS')) {\n` +
        `  console.log('PROCESSORS 8\\nSLICE_PROCESSORS 8\\nLOAD 0\\nMEMORY_HEADROOM 8589934592\\nMEMORY_CURRENT -\\nMEMORY_MAX -\\nSLOTS_USED 0\\nGATE_WAITING 0');\n` +
        `  process.exit(0);\n` +
        `}\n` +
        `if (script.includes('REMOTE_CHECK_SLOT_TAKE')) {\n` +
        `  if (!existsSync(state + '/release-slot')) process.exit(75);\n` +
        `  console.log('SLOTS 1');\n` +
        `  process.stdin.on('end', () => process.exit(0));\n` +
        `  process.stdin.resume();\n` +
        `} else if (script.includes('systemd-run')) process.exit(0);\n` +
        `else process.exit(0);\n`,
    );
    const rsync = join(bin, 'rsync');
    writeFileSync(rsync, '#!/usr/bin/env bun\nprocess.exit(0);\n');
    chmodSync(ssh, 0o755);
    chmodSync(rsync, 0o755);
    const hostsFile = join(fakeDirectory, 'hosts.json');
    writeFileSync(
      hostsFile,
      JSON.stringify({
        hosts: [
          {
            name: 'fake',
            address: 'ops@fake.test',
            identity: '/keys/fake',
            memoryMaxGiB: 8,
            cpuQuotaPercent: 800,
            slots: 1,
          },
        ],
      }),
    );
    env.FAKE_CHECK_HOST_DIR = fakeDirectory;
    env.KERNEL_CHECK_REMOTE = hostsFile;
    env.REMOTE_CHECK_POLL_MS = '20';
    env.PATH = `${bin}:${env.PATH}`;
  } else {
    // A missing hosts file keeps the test on this machine after the host route declines it.
    env.KERNEL_CHECK_REMOTE = join(directory, 'no-such-hosts.json');
  }

  let holder: Bun.Subprocess<'pipe', 'ignore', 'ignore'> | undefined;
  if (options.holdLocalSlot) {
    const leaseDirectory = join(directory, 'lease');
    mkdirSync(leaseDirectory, { recursive: true });
    const lock = join(leaseDirectory, 'slot-1.lock');
    writeFileSync(lock, '');
    holder = Bun.spawn(['flock', '-n', lock, 'cat'], {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    heldSlots.push(holder);
    await waitFor(() => slotIsHeld(directory));
  }

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
  return { run, directory, marker, goalMarker, waitFile, ...(holder === undefined ? {} : { holder }) };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

function slotIsHeld(directory: string): boolean {
  return Bun.spawnSync(['flock', '-n', '-E', '75', join(directory, 'lease/slot-1.lock'), 'true']).exitCode === 75;
}

afterEach(async () => {
  for (const holder of heldSlots.splice(0)) {
    if (holder.exitCode === null) await holder.stdin.end();
    await holder.exited;
  }
  for (const run of runs.splice(0)) {
    await run.child.stdin.end();
    if (run.child.exitCode === null) run.child.kill('SIGTERM');
    await run.child.exited;
    await run.done;
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('a root test run that includes specs holds one slot for its process', async () => {
  const { run, directory, marker, goalMarker } = await startRootTest('specs');
  await waitFor(() => existsSync(marker));
  expect(readFileSync(marker, 'utf8')).toBe('1/1');
  expect(readFileSync(goalMarker, 'utf8')).toBe('[]');
  expect(slotIsHeld(directory)).toBe(true);

  await run.child.stdin.end();
  expect(await run.child.exited).toBe(0);
  await run.done;
  expect(slotIsHeld(directory)).toBe(false);
});

test('a root test run without specs takes no slot', async () => {
  const { run, directory, marker, goalMarker } = await startRootTest('scripts');
  await waitFor(() => existsSync(marker));
  expect(readFileSync(marker, 'utf8')).toBe('');
  expect(readFileSync(goalMarker, 'utf8')).toBe('[]');
  expect(slotIsHeld(directory)).toBe(false);

  await run.child.stdin.end();
  expect(await run.child.exited).toBe(0);
  await run.done;
  expect(slotIsHeld(directory)).toBe(false);
});

test('a root bun test routed to a check host records its slot wait in the attempt wait file', async () => {
  const { run, directory, waitFile } = await startRootTest('specs', { routeToCheckHost: true });
  await waitFor(
    () =>
      run.output.stderr.includes('remote-check: every check slot is busy; waiting for a free one') &&
      existsSync(waitFile) &&
      readFileSync(waitFile, 'utf8').split('\n').some((line) => /^\d+$/.test(line) && Number(line) > 0),
    20_000,
  ).catch((error) => {
    throw new Error(`${error}\nstdout: ${run.output.stdout}\nstderr: ${run.output.stderr}`);
  });
  expect(run.child.exitCode).toBeNull();
  expect(readFileSync(waitFile, 'utf8').trim()).toMatch(/^\d+(?:\n\d+)*$/);

  writeFileSync(join(directory, 'fake-check-host/release-slot'), 'release');
  expect(await run.child.exited).toBe(0);
  await run.done;
  expect(readFileSync(waitFile, 'utf8').trim()).toMatch(/^\d+(?:\n\d+)*$/);
}, 30_000);

test("a root bun test waiting for a stack slot records its wait in the attempt's wait file", async () => {
  const { run, directory, marker, goalMarker, waitFile, holder } = await startRootTest('specs', {
    holdLocalSlot: true,
  });
  expect(holder).toBeDefined();
  await waitFor(
    () =>
      run.output.stderr.includes('stack-lease: root bun test waiting (1/1 held, 0 ahead)') &&
      existsSync(waitFile) &&
      readFileSync(waitFile, 'utf8').split('\n').some((line) => /^\d+$/.test(line) && Number(line) > 0),
    20_000,
  ).catch((error) => {
    throw new Error(`${error}\nstdout: ${run.output.stdout}\nstderr: ${run.output.stderr}`);
  });
  expect(existsSync(marker)).toBe(false);

  await holder!.stdin.end();
  await holder!.exited;
  const holderIndex = heldSlots.indexOf(holder!);
  if (holderIndex !== -1) heldSlots.splice(holderIndex, 1);

  await waitFor(() => existsSync(marker));
  expect(readFileSync(marker, 'utf8')).toBe('1/1');
  expect(readFileSync(goalMarker, 'utf8')).toBe('[]');
  expect(readFileSync(waitFile, 'utf8').trim()).toMatch(/^\d+(?:\n\d+)*$/);
  await run.child.stdin.end();
  expect(await run.child.exited).toBe(0);
  await run.done;
  expect(slotIsHeld(directory)).toBe(false);
}, 30_000);
