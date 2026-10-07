import { expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fusekiImageFromCompose } from '../../../scripts/load/image.ts';
import {
  allocateJenaRun,
  jenaCheck,
  jenaCleanupMs,
  jenaContainerArguments,
  jenaExecutionMs,
  jenaNamePrefix,
  jenaRefusal,
  jenaScratchGraph,
  type JenaCommandResult,
} from '../../../scripts/qa/jena-cli.ts';

const root = resolve(import.meta.dir, '../../..');
const image = fusekiImageFromCompose(
  readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8'),
).image;
const ok = (stdout = ''): JenaCommandResult => ({ status: 0, stdout, stderr: '', signal: null });
const idOf = (name: string) => Buffer.from(name).toString('hex').padEnd(64, 'a').slice(0, 64);

test('each run mounts only its own scratch directory and cannot raise its bounds', () => {
  const first = allocateJenaRun('.temp/jena-cli-args');
  const second = allocateJenaRun('.temp/jena-cli-args');
  expect(first.name).not.toBe(second.name);
  expect(first.directory).not.toBe(second.directory);
  expect(first.name.startsWith(jenaNamePrefix)).toBe(true);
  expect(first.name).not.toBe('rezics-jena-cli');
  const args = jenaContainerArguments(image, first.directory, first.name);
  expect(args).toContain(first.name);
  expect(args).not.toContain('rezics-jena-cli');
  expect(args).toContain('--pull=never');
  expect(args).toContain('--network');
  expect(args).toContain('none');
  expect(args).toContain('--memory');
  expect(args).toContain('768m');
  expect(args).toContain('--read-only');
  expect(args[args.indexOf('--volume') + 1]).toBe(`${first.directory}:/artifacts:ro,Z`);
  expect(args.some((part) => part === root || part.startsWith(`${root}:`))).toBe(false);
  expect(args.some((part) => part.includes('/.temp/vault'))).toBe(false);
  expect(args).not.toContain('pull');
  expect(args).not.toContain('build');
  expect(args).not.toContain('rm');
  expect(Number(args.at(-1))).toBe(90);
  expect(() => jenaContainerArguments(image, first.directory, 'rezics-jena-cli')).toThrow(
    /one run/,
  );
  const source = readFileSync(join(root, 'scripts/qa/jena-cli.ts'), 'utf8');
  expect(source).not.toContain('docker pull');
  expect(source).not.toContain('docker build');
  expect(source).not.toContain("'rezics-jena-cli'");
  expect(jenaExecutionMs).toBe(60_000);
  expect(jenaCleanupMs).toBe(15_000);
  expect(() =>
    jenaCheck({
      directory: '.temp/vault/jena',
      dockerEnv: process.env,
      imagePresent: () => true,
      run: () => {
        throw new Error('ran');
      },
    }),
  ).toThrow(/vault/);
  expect(() =>
    jenaCheck({
      directory: 'model/definitions',
      dockerEnv: process.env,
      imagePresent: () => true,
      run: () => {
        throw new Error('ran');
      },
    }),
  ).toThrow(/\.temp/);
  expect(() =>
    jenaRefusal('turtle', '/etc/passwd', {
      imagePresent: () => {
        throw new Error('inspected');
      },
    }),
  ).toThrow(/checkout/);
  const refused = spawnSync('bun', ['scripts/qa/jena-cli.ts', '--loc', '/tmp/live'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(refused.status).toBe(2);
  expect(refused.stderr).toContain('no dataset or path arguments');
});

test('a missing pinned image stops before any container, pull, or older tag', () => {
  let ran = false;
  expect(() =>
    jenaCheck({
      imagePresent: () => false,
      run: () => {
        ran = true;
        return ok();
      },
    }),
  ).toThrow(`Pinned Fuseki image is not present: ${image}`);
  expect(ran).toBe(false);

  const seen: string[][] = [];
  expect(() =>
    jenaCheck({
      directory: '.temp/jena-cli-missing',
      dockerEnv: process.env,
      deadlineMs: 60_000,
      run: (command, bounds) => {
        seen.push(command);
        expect(bounds.timeoutMs).toBeGreaterThan(10_000);
        expect(bounds.timeoutMs).toBeLessThanOrEqual(jenaExecutionMs);
        expect(command.slice(0, 4)).toEqual(['docker', 'image', 'inspect', image]);
        return { status: 1, stdout: '', stderr: 'absent', signal: null };
      },
    }),
  ).toThrow(/refusing an older local tag/);
  expect(seen).toHaveLength(1);
  expect(
    seen.some(
      (command) =>
        command.includes('pull') ||
        command.includes('build') ||
        command.includes('run') ||
        command.includes('rm'),
    ),
  ).toBe(false);
  expect(image).not.toContain('c04c234006fa');
});

test('cleanup is separately bounded and removes only the container this run started', () => {
  const seen: { command: string[]; timeoutMs: number }[] = [];
  const other = 'c'.repeat(64);
  expect(() =>
    jenaCheck({
      directory: '.temp/jena-cli-deadline',
      dockerEnv: process.env,
      imagePresent: () => true,
      deadlineMs: 5_000,
      run: (command, bounds) => {
        seen.push({ command, timeoutMs: bounds.timeoutMs });
        if (command[1] === 'rm') return ok();
        if (command[1] === 'run') {
          expect(bounds.timeoutMs).toBeLessThanOrEqual(5_000);
          const name = command[command.indexOf('--name') + 1]!;
          return ok(`${idOf(name)}\n`);
        }
        return { status: null, stdout: '', stderr: '', signal: 'SIGTERM' };
      },
    }),
  ).toThrow(/deadline exceeded/);
  const started = seen.find((item) => item.command[1] === 'run');
  const name = started?.command[started.command.indexOf('--name') + 1];
  const owned = name ? idOf(name) : '';
  expect(name?.startsWith(jenaNamePrefix)).toBe(true);
  expect(started?.command.slice(0, 3)).toEqual(['docker', 'run', '-d']);
  expect(seen[0]?.command[1]).toBe('run');
  expect(seen.at(-1)?.command).toEqual(['docker', 'rm', '-f', owned]);
  expect(seen.at(-1)?.timeoutMs).toBe(jenaCleanupMs);
  expect(seen.filter((item) => item.command[1] === 'rm')).toHaveLength(1);
  expect(
    seen.some((item) => item.command.includes(other) || item.command.includes('rezics-jena-cli')),
  ).toBe(false);

  const outputId = 'd'.repeat(12);
  const output: { command: string[]; timeoutMs: number }[] = [];
  expect(() =>
    jenaCheck({
      directory: '.temp/jena-cli-output',
      dockerEnv: process.env,
      imagePresent: () => true,
      maxOutputBytes: 64,
      run: (command, bounds) => {
        output.push({ command, timeoutMs: bounds.timeoutMs });
        if (command[1] === 'rm') return ok();
        if (command[1] === 'run') return ok(`${outputId}\n`);
        return ok('x'.repeat(65));
      },
    }),
  ).toThrow(/output exceeded 1 MiB/);
  expect(output.at(-1)?.command).toEqual(['docker', 'rm', '-f', outputId]);
  expect(output.at(-1)?.timeoutMs).toBe(jenaCleanupMs);
  expect(output.filter((item) => item.command[1] === 'rm')).toHaveLength(1);
});

test("a refused tool status is kept and only that run's container is removed", () => {
  const turtleId = 'e'.repeat(64);
  const turtle: string[][] = [];
  const refusedTurtle = jenaRefusal('turtle', 'tests/fixtures/jena-cli/malformed.ttl', {
    directory: '.temp/jena-cli-refusal',
    dockerEnv: process.env,
    imagePresent: () => true,
    run: (command) => {
      turtle.push(command);
      if (command[1] === 'rm') return ok();
      if (command[1] === 'run') return ok(`${turtleId}\n`);
      expect(command).toContain('riotcmd.riot');
      expect(command).toContain('--validate');
      expect(command).toContain('/artifacts/stage/input.ttl');
      return { status: 1, stdout: 'Broken token (newline in string)\n', stderr: '', signal: null };
    },
  });
  expect(refusedTurtle.status).not.toBe(0);
  expect(refusedTurtle.output).toContain('Broken token (newline in string)');
  expect(turtle.at(-1)).toEqual(['docker', 'rm', '-f', turtleId]);

  const queryId = 'f'.repeat(64);
  const query: string[][] = [];
  const refusedQuery = jenaRefusal('query', 'tests/fixtures/jena-cli/malformed.rq', {
    directory: '.temp/jena-cli-refusal',
    dockerEnv: process.env,
    imagePresent: () => true,
    run: (command) => {
      query.push(command);
      if (command[1] === 'rm') return ok();
      if (command[1] === 'run') return ok(`${queryId}\n`);
      expect(command).toContain('arq.qparse');
      expect(command).toContain('--query');
      return {
        status: 2,
        stdout: '',
        stderr: 'Encountered "<EOF>" at line 1, column 18.\n',
        signal: null,
      };
    },
  });
  expect(refusedQuery.status).not.toBe(0);
  expect(refusedQuery.output).toContain('Encountered "<EOF>"');
  expect(query.at(-1)).toEqual(['docker', 'rm', '-f', queryId]);
  expect(query.some((command) => command.includes(turtleId))).toBe(false);
});

function writeFakeDocker(sleepSeconds: string): { env: NodeJS.ProcessEnv; log: string } {
  const directory = join(root, '.temp', `jena-cli-fake-${randomId()}`);
  mkdirSync(directory, { recursive: true });
  const log = join(directory, 'docker.log');
  writeFileSync(log, '');
  const bin = join(directory, 'docker');
  writeFileSync(
    bin,
    `#!/bin/sh
log=\${JENA_FAKE_DOCKER_LOG:?}
record() { flock -x 9; printf '%s\\n' "$1" >&9; } 9>>"$log"
if [ "$1" = info ]; then echo 29.0.0; exit 0; fi
if [ "$1" = image ]; then
  record "inspect $3"
  echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  exit 0
fi
if [ "$1" = run ]; then
  name= prev=
  for arg in "$@"; do
    if [ "$prev" = --name ]; then name=$arg; fi
    prev=$arg
  done
  id=$(printf '%s' "$name" | sha256sum | awk '{print $1}')
  record "run $name $id"
  printf '%s\\n' "$id"
  exit 0
fi
if [ "$1" = exec ]; then
  id=$2
  record "exec $id"
  if [ ! -f "$log.slept.$id" ]; then
    : > "$log.slept.$id"
    end=$(( $(date +%s) + ${sleepSeconds} ))
    while [ "$(date +%s)" -lt "$end" ]; do
      if grep -q "^rm $id$" "$log"; then exit 0; fi
      sleep 0.2
    done
  fi
  case "$*" in
    *--graph=*) printf '%s\\n' '(count 2)' '(<https://rezics.com/jena-cli/extra> 1)' ;;
    *tdb2.tdbstats*) printf '%s\\n' '(count 1)' ;;
    *arq.qparse*) printf '%s\\n' 'BIND("text-variant" AS ?kind)' ;;
  esac
  exit 0
fi
if [ "$1" = rm ]; then
  token=
  for arg in "$@"; do
    case "$arg" in
      rm|-f) ;;
      *) token=$arg ;;
    esac
  done
  record "rm $token"
  exit 0
fi
echo "unexpected docker $*" >&2
exit 1
`,
  );
  chmodSync(bin, 0o755);
  return {
    log,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      JENA_FAKE_DOCKER_LOG: log,
    },
  };
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 14);
}

function spawnCli(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn('bun', ['scripts/qa/jena-cli.ts'], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function stopGroup(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function waitExit(
  child: ChildProcess,
  ms: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Jena CLI did not exit\n${stderr}`)), ms);
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      done({ code: signal ? 143 : (status ?? 1), stdout, stderr });
    });
  });
}

async function waitForLog(log: string, pattern: RegExp, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  let text = '';
  while (Date.now() < deadline) {
    try {
      text = readFileSync(log, 'utf8');
    } catch {
      text = '';
    }
    if (pattern.test(text)) return text;
    await Bun.sleep(100);
  }
  throw new Error(`log did not match ${pattern}\n${text}`);
}

test('controlled processes keep overlapping runs apart and clean up after PID-only or group cancellation', async () => {
  const success = writeFakeDocker('1');
  const first = spawnCli(success.env);
  const second = spawnCli(success.env);
  try {
    const [left, right] = await Promise.all([waitExit(first, 90_000), waitExit(second, 90_000)]);
    expect(left.code).toBe(0);
    expect(right.code).toBe(0);
    const log = readFileSync(success.log, 'utf8');
    expect(log).toContain(`inspect ${image}`);
    const events = log.trim().split('\n');
    const runs = events.filter((line) => line.startsWith('run '));
    const rmAt = events.findIndex((line) => line.startsWith('rm '));
    expect(runs).toHaveLength(2);
    expect(events.slice(0, rmAt).filter((line) => line.startsWith('run '))).toHaveLength(2);
    const ids = runs.map((line) => line.split(' ')[2]!);
    expect(new Set(ids).size).toBe(2);
    const removed = events
      .filter((line) => line.startsWith('rm '))
      .map((line) => line.split(' ')[1]!);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((token) => ids.includes(token))).toBe(true);
    const evidences = [left.stdout.trim().split(' ')[0]!, right.stdout.trim().split(' ')[0]!];
    expect(evidences[0]).not.toBe(evidences[1]);
    for (const evidencePath of evidences) {
      const evidence = JSON.parse(readFileSync(join(root, evidencePath), 'utf8')) as {
        image: string;
        container: string;
        name: string;
        mount: string;
        defaultCount: number;
        namedCount: number;
        scratchGraph: string;
        statsOpt: string;
        riotFiles: number;
      };
      expect(evidence.image).toBe(image);
      expect(ids).toContain(evidence.container);
      expect(evidence.name.startsWith(jenaNamePrefix)).toBe(true);
      expect(evidence.mount.startsWith('.temp/jena-cli/')).toBe(true);
      expect(evidence.defaultCount).toBe(1);
      expect(evidence.namedCount).toBe(2);
      expect(evidence.scratchGraph).toBe(jenaScratchGraph);
      expect(evidence.statsOpt).toBe('absent');
      expect(evidence.riotFiles).toBeGreaterThan(100);
    }
  } finally {
    stopGroup(first);
    stopGroup(second);
  }

  const cancelled = writeFakeDocker('20');
  const victim = spawnCli(cancelled.env);
  const decoy = spawnCli(cancelled.env);
  try {
    const started = await waitForLog(
      cancelled.log,
      /(?:^|\n)exec [0-9a-f]{64}\n(?:.|\n)*exec [0-9a-f]{64}/,
      30_000,
    );
    const execIds = [
      ...new Set([...started.matchAll(/^exec ([0-9a-f]{64})$/gm)].map((match) => match[1]!)),
    ];
    expect(execIds).toHaveLength(2);
    const pendingVictim = waitExit(victim, 20_000);
    process.kill(victim.pid!, 'SIGTERM');
    const victimExit = await pendingVictim;
    expect(victimExit.code).not.toBe(0);
    const afterPid = await waitForLog(cancelled.log, /^rm [0-9a-f]{64}$/m, 15_000);
    const victimIds = [
      ...new Set([...afterPid.matchAll(/^rm (\S+)$/gm)].map((match) => match[1]!)),
    ];
    expect(victimIds).toHaveLength(1);
    expect(execIds).toContain(victimIds[0]);
    const victimId = victimIds[0]!;
    const decoyId = execIds.find((id) => id !== victimId);
    expect(decoyId).toBeTruthy();
    expect(afterPid).not.toContain(`rm ${decoyId}`);
    expect(decoy.exitCode).toBeNull();

    const pendingDecoy = waitExit(decoy, 20_000);
    process.kill(-decoy.pid!, 'SIGTERM');
    const decoyExit = await pendingDecoy;
    expect(decoyExit.code).not.toBe(0);
    await waitForLog(cancelled.log, new RegExp(`^rm ${decoyId}$`, 'm'), 15_000);
    const afterGroup = readFileSync(cancelled.log, 'utf8');
    const removed = [...afterGroup.matchAll(/^rm (\S+)$/gm)].map((match) => match[1]!);
    expect(removed.every((token) => token === victimId || token === decoyId)).toBe(true);
    expect(removed).toContain(decoyId);
  } finally {
    stopGroup(victim);
    stopGroup(decoy);
  }
}, 120_000);
