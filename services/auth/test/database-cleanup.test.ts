import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const listing = [
  'ps',
  '-a',
  '--filter',
  'label=rezics.auth.check.pid',
  '--format',
  '{{.ID}} {{.Label "rezics.auth.check.pid"}}',
];

function fakeDocker(rows: string[], options: { gone?: string[]; listingFailure?: boolean } = {}) {
  const root = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(root, { recursive: true });
  const temporary = mkdtempSync(join(root, 'auth-cleanup-'));
  const log = join(temporary, 'docker.jsonl');
  const shim = join(temporary, 'docker');
  writeFileSync(log, '');
  writeFileSync(
    shim,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const rows = ${JSON.stringify(rows)};
const gone = ${JSON.stringify(options.gone ?? [])};
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') {
  if (${Boolean(options.listingFailure)} && args.includes('--format')) {
    console.error('listing unavailable');
    process.exit(71);
  }
  console.log(args.includes('--format') ? rows.join('\\n') : '');
} else if (args[0] === 'inspect') {
  if (gone.includes(args.at(-1))) {
    console.error('No such object: ' + args.at(-1));
    process.exit(1);
  }
  console.log(rows.find(row => row.split(' ')[0] === args.at(-1))?.split(' ')[1] ?? '');
} else if (args[0] === 'rm') {
  if (gone.includes(args.at(-1))) {
    console.error('No such container: ' + args.at(-1));
    process.exit(1);
  }
} else if (args[0] === 'run') {
  // Stop before fixture creation or migrations; this shim never calls real Docker.
  console.error('fixture setup reached');
  process.exit(73);
} else if (args[0] === 'volume') {
} else {
  console.error('Unexpected Docker command');
  process.exit(74);
}
`,
  );
  chmodSync(shim, 0o755);
  try {
    const module = resolve(import.meta.dir, '../scripts/database.ts');
    const result = Bun.spawnSync(
      [process.execPath, '-e', `import { ownDatabase } from ${JSON.stringify(module)}; ownDatabase();`],
      {
        env: {
          ...process.env,
          PATH: `${temporary}:${process.env.PATH ?? ''}`,
          AUTH_CHECK_CONTAINER: 'fake-lane',
          DATABASE_URL: 'postgres://fake/lane',
          AUTH_CHECK_LANE_OWNER: String(process.pid),
        },
        timeout: 10_000,
      },
    );
    const commands = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    if (!options.listingFailure) {
      const start = commands.find((args) => args[0] === 'run')!;
      const nonce = start.find((arg) => arg.startsWith('rezics.auth.check.nonce='))!;
      expect(commands.slice(commands.indexOf(start) + 1)).toEqual([
        ['ps', '-aq', '--filter', `label=${nonce}`],
        ['ps', '-aq', '--filter', expect.stringMatching(/^label=rezics.auth.check.pid=/)],
        ['volume', 'ls', '-q', '--filter', expect.stringMatching(/^label=rezics.auth.check.pid=/)],
      ]);
    }
    return { result, commands };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('one docker listing carries owner pid without inspect race', () => {
  const { result, commands } = fakeDocker([`live ${process.pid}`]);
  expect(result.stderr.toString()).toContain('fixture setup reached');
  expect(
    commands.slice(
      0,
      commands.findIndex((args) => args[0] === 'run'),
    ),
  ).toEqual([listing]);
  expect(commands.some((args) => args[0] === 'rm')).toBe(false);
});

test('stale owner removed and live owner retained', async () => {
  const live = Bun.spawn([process.execPath, '-e', 'await Bun.stdin.text()'], { stdin: 'pipe' });
  const dead = Bun.spawn([process.execPath, '-e', 'process.exit(0)']);
  await dead.exited;
  try {
    const { result, commands } = fakeDocker([`live ${live.pid}`, `stale ${dead.pid}`]);
    expect(result.stderr.toString()).toContain('fixture setup reached');
    expect(
      commands.slice(
        0,
        commands.findIndex((args) => args[0] === 'run'),
      ),
    ).toEqual([listing, ['rm', '-f', '-v', 'stale']]);
    expect(commands.filter((args) => args[0] === 'rm')).toEqual([['rm', '-f', '-v', 'stale']]);
    expect(() => process.kill(live.pid, 0)).not.toThrow();
    expect(live.exitCode).toBeNull();
  } finally {
    live.stdin.end();
    await live.exited;
  }
});

test('concurrent already-gone removal succeeds', async () => {
  const dead = Bun.spawn([process.execPath, '-e', 'process.exit(0)']);
  await dead.exited;
  const { result, commands } = fakeDocker([`vanished ${dead.pid}`], { gone: ['vanished'] });
  expect(result.stderr.toString()).toContain('fixture setup reached');
  expect(
    commands.slice(
      0,
      commands.findIndex((args) => args[0] === 'run'),
    ),
  ).toEqual([listing, ['rm', '-f', '-v', 'vanished']]);
  expect(commands.filter((args) => args[0] === 'rm')).toEqual([['rm', '-f', '-v', 'vanished']]);
});

test('malformed owners are conservatively retained', () => {
  const owners = ['', 'not-a-pid', '0', '-1', '1.5', 'Infinity', '9007199254740993', `+${process.pid}`, '1e3'];
  const { result, commands } = fakeDocker(owners.map((owner, index) => `malformed${index} ${owner}`));
  expect(result.stderr.toString()).toContain('fixture setup reached');
  expect(
    commands.slice(
      0,
      commands.findIndex((args) => args[0] === 'run'),
    ),
  ).toEqual([listing]);
  expect(commands.some((args) => args[0] === 'rm')).toBe(false);
  expect(() => process.kill(process.pid, 0)).not.toThrow();
});

test('listing and setup failures still propagate', () => {
  const failed = fakeDocker([], { listingFailure: true });
  expect(failed.result.exitCode).not.toBe(0);
  expect(failed.result.stderr.toString()).toContain('listing unavailable');
  expect(failed.commands).toEqual([listing]);

  const setup = fakeDocker([]);
  expect(setup.result.exitCode).not.toBe(0);
  expect(setup.result.stderr.toString()).toContain('fixture setup reached');
  expect(setup.commands[0]).toEqual(listing);
  expect(setup.commands[1]?.[0]).toBe('run');
});
