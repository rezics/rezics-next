import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../../..');
const checkScript = resolve(import.meta.dir, '../scripts/check.ts');
const kept: string[] = [];

const fakeSsh = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const script = args.at(-1) ?? '';
const address = args.at(-2) ?? '';
const log = (event) => appendFileSync(dir + '/log.jsonl', JSON.stringify({ address, ...event }) + '\\n');
if (script.includes('MemAvailable')) {
  log({ kind: 'probe' });
  console.log('MEMORY_CURRENT -\\nMEMORY_MAX -\\nMEMORY_HEADROOM 30000000000\\nPROCESSORS 16\\nSLICE_PROCESSORS 8\\nLOAD 0\\nORDINARY_SLOTS_USED 0\\nEXPRESS_SLOT_USED 0\\nGATE_WAITING 0');
} else if (script.includes('REMOTE_CHECK_SLOT_TAKE')) {
  const count = Number(script.match(/# REMOTE_CHECK_SLOT_COUNT (\\d+)/)?.[1] ?? 1);
  log({ kind: 'slot', granted: true, script });
  console.log('SLOTS ' + count);
  const release = () => {
    log({ kind: 'release' });
    process.exit(0);
  };
  process.stdin.on('end', release);
  process.on('SIGTERM', release);
  process.stdin.resume();
} else if (script.includes('systemd-run')) {
  log({ kind: 'run', script });
  process.exit(0);
} else {
  log({ kind: 'cleanup' });
}
`;

const fakeRsync = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const input = await Bun.stdin.text();
appendFileSync(process.env.FAKE_DIR + '/log.jsonl', JSON.stringify({
  kind: 'rsync',
  destination: args.at(-1),
  files: input.split('\\0').filter(Boolean),
}) + '\\n');
`;

type Event = { kind: string; address?: string; script?: string };

afterAll(() => {
  for (const directory of kept.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function eventsOf(directory: string): Event[] {
  const file = join(directory, 'log.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event)
    : [];
}

function prepare(): { directory: string; env: Record<string, string>; workspace: string } {
  // The kernel check may already be running under a check host's run directory. A fixture inside that tree would be
  // treated as on a check host, so the fixture lives in the system temp directory.
  const directory = mkdtempSync(join(tmpdir(), 'check-remote-placement-'));
  kept.push(directory);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  for (const [name, source] of [
    ['ssh', fakeSsh],
    ['rsync', fakeRsync],
  ] as const) {
    const file = join(bin, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }
  writeFileSync(
    join(directory, 'hosts.json'),
    JSON.stringify({
      hosts: [
        {
          name: 'a',
          address: 'ops@a.test',
          identity: '/keys/a',
          memoryMaxGiB: 16,
          cpuQuotaPercent: 800,
          slots: 2,
        },
      ],
    }),
  );
  const workspace = join(directory, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src/tracked.ts'), 'export {};\n');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  const timings = join(directory, 'timings');
  mkdirSync(timings);
  writeFileSync(join(timings, 'latest.json'), '{}');
  return {
    directory,
    workspace,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DIR: directory,
      KERNEL_CHECK_REMOTE: join(directory, 'hosts.json'),
      KERNEL_CHECK_ON_REMOTE: '1',
      REZICS_STACK_LEASE: 'off',
      GOAL_TASK_ID: 'worker',
      KERNEL_CHECK_CONCURRENCY: '2',
      REMOTE_CHECK_POLL_MS: '20',
      KERNEL_CHECK_TIMINGS: timings,
    },
  };
}

function writeLatest(directory: string, files: Record<string, number>): void {
  const path = join(directory, 'timings/latest.json');
  writeFileSync(
    path,
    JSON.stringify({
      files: Object.fromEntries(
        Object.entries(files).map(([file, wall]) => [
          file,
          { wall, create: 0, drop: 0, outsideTests: 0, result: 'pass', tests: [] },
        ]),
      ),
    }),
  );
}

// A fresh process, so its ssh lookup sees the fake at the front of PATH. Bun keeps the PATH it started with.
const runner = `import { placeKernelCheck } from ${JSON.stringify(checkScript)};
const code = await placeKernelCheck(JSON.parse(process.env.PLAN ?? ''), process.env, {
  root: process.env.WORKSPACE ?? '',
  cwd: process.env.WORK_CWD ?? '',
});
console.log(JSON.stringify({ code }));
`;

async function placed(
  env: Record<string, string>,
  plan: { files: string[] | null; tests: string[] },
  workspace: string,
  cwd: string,
): Promise<{ code: number | null; stderr: string }> {
  const child = Bun.spawn(['bun', '-e', runner], {
    cwd: repository,
    env: { ...process.env, ...env, PLAN: JSON.stringify(plan), WORKSPACE: workspace, WORK_CWD: cwd },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`placement helper exited ${code}\n${stderr}\n${stdout}`);
  return { code: (JSON.parse(stdout) as { code: number | null }).code, stderr };
}

test('the kernel check uses the shared placement decision', async () => {
  const source = readFileSync(resolve(import.meta.dir, '../scripts/check.ts'), 'utf8');
  expect(source).toContain('placeKernelCheck(plan)');
  expect(source).not.toContain('remoteHostsFile');
  expect(source).not.toContain('KERNEL_CHECK_ON_REMOTE');

  const { directory, env, workspace } = prepare();
  const plan = { files: ['test/check-remote-placement.test.ts'], tests: ['test/check-remote-placement.test.ts'] };
  const remote = await placed(env, plan, workspace, join(workspace, 'src'));
  expect(remote.code).toBe(0);
  expect(remote.stderr).toContain('stack-run: kernel check on a');
  const seen = eventsOf(directory);
  const run = seen.find((event) => event.kind === 'run');
  expect(run?.address).toBe('ops@a.test');
  expect(run?.script).toContain(
    'env KERNEL_CHECK_CONCURRENCY=2 bun scripts/check.ts test/check-remote-placement.test.ts',
  );
  expect(seen.some((event) => event.kind === 'rsync')).toBe(true);
  expect(
    seen
      .filter((event) => event.address === 'ops@a.test')
      .map((event) => event.kind)
      .slice(-2),
  ).toEqual(['cleanup', 'release']);

  const stayed = await placed(env, plan, workspace, '/srv/rezics-check/runs/example/services/kernel');
  expect(stayed.code).toBeNull();
  expect(stayed.stderr).toContain('stack-run: kernel check local, already on a check host');
  expect(eventsOf(directory).filter((event) => event.kind === 'run')).toHaveLength(1);

  const empty = await placed(env, { files: [], tests: [] }, workspace, join(workspace, 'src'));
  expect(empty.code).toBeNull();
  expect(eventsOf(directory).filter((event) => event.kind === 'run')).toHaveLength(1);
}, 30_000);

test('the kernel check estimates only a fully timed named plan', async () => {
  const { directory, env, workspace } = prepare();
  writeLatest(directory, { 'test/check-remote-placement.test.ts': 12.345 });
  await placed(
    env,
    { files: ['test/check-remote-placement.test.ts'], tests: ['test/check-remote-placement.test.ts'] },
    workspace,
    join(workspace, 'src'),
  );
  expect(eventsOf(directory).find((event) => event.kind === 'slot')?.script).toContain(
    '# REMOTE_CHECK_ESTIMATE_MS 12345',
  );

  const allTimed = prepare();
  writeLatest(allTimed.directory, { 'test/a.test.ts': 2.25, 'test/b.test.ts': 3.5 });
  const selected = {
    files: ['test/a.test.ts', 'test/b.test.ts'],
    tests: ['test/a.test.ts', 'test/b.test.ts'],
  };
  await placed(allTimed.env, selected, allTimed.workspace, join(allTimed.workspace, 'src'));
  expect(eventsOf(allTimed.directory).find((event) => event.kind === 'slot')?.script).toContain(
    '# REMOTE_CHECK_ESTIMATE_MS 5750',
  );

  writeLatest(allTimed.directory, { 'test/a.test.ts': 2.25 });
  await placed(allTimed.env, selected, allTimed.workspace, join(allTimed.workspace, 'src'));
  expect(eventsOf(allTimed.directory).filter((event) => event.kind === 'slot')[1]?.script).toContain(
    '# REMOTE_CHECK_ESTIMATE_MS none',
  );

  writeLatest(allTimed.directory, { 'test/a.test.ts': 2.25, 'test/b.test.ts': 3.5 });
  await placed(
    allTimed.env,
    { files: null, tests: selected.tests },
    allTimed.workspace,
    join(allTimed.workspace, 'src'),
  );
  expect(eventsOf(allTimed.directory).filter((event) => event.kind === 'slot')[2]?.script).toContain(
    '# REMOTE_CHECK_ESTIMATE_MS none',
  );
}, 30_000);
