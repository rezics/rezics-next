import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeAttemptContainers } from './worker-containers.ts';

const root = resolve(import.meta.dir, '../../..');
const wrapper = join(root, 'scripts/check-host/docker');
const image = 'busybox:latest';
const labelName = 'rezics.worker.attempt';

type DockerCall = {
  argv: string[];
  forwardedArgv: string[];
  stdout: string;
  stderr: string;
  status: number | null;
  interrupted: boolean;
};

function discoverDocker(): string | undefined {
  const found = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() || undefined : undefined;
}

function nativeUnavailableReason(dockerPath: string | undefined): string | undefined {
  if (!existsSync(wrapper)) return 'check-host Docker wrapper unavailable';
  if (!dockerPath) return 'Docker CLI unavailable';
  const daemon = spawnSync(dockerPath, ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (daemon.error || daemon.status !== 0) return 'Docker daemon unavailable';
  const imageCheck = spawnSync(dockerPath, ['image', 'inspect', image], { encoding: 'utf8', timeout: 10_000 });
  return imageCheck.error || imageCheck.status !== 0 ? `${image} unavailable` : undefined;
}

const dockerPath = discoverDocker();
const unavailable = nativeUnavailableReason(dockerPath);

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function ids(output: string): string[] {
  return output.trim().split(/\s+/).filter(Boolean);
}

function sameId(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

function expectSameIds(actual: string[], expected: string[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const expectedId of expected) {
    expect(actual.some((actualId) => sameId(actualId, expectedId))).toBe(true);
  }
}

test.serial.skipIf(unavailable !== undefined)(
  `native attempt cleanup reports exact ownership and bounded observable work${unavailable ? ` (unavailable: ${unavailable})` : ''}`,
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'worker-containers-native-'));
    const bin = join(directory, 'bin');
    const traceFile = join(directory, 'docker-calls.jsonl');
    const interruptionMarker = join(directory, 'interrupted');
    mkdirSync(bin);
    const shim = join(bin, 'docker');
    executable(
      shim,
      `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const interrupted = process.env.WORKER_NATIVE_INTERRUPT_FIRST_RM === '1' && argv[0] === 'rm' && !existsSync(process.env.WORKER_NATIVE_INTERRUPT_MARKER!);
if (interrupted) writeFileSync(process.env.WORKER_NATIVE_INTERRUPT_MARKER!, 'interrupted');
const forwardedArgv = interrupted ? [...argv.slice(0, 3), argv[3]!] : argv;
const result = spawnSync(process.env.WORKER_NATIVE_REAL_DOCKER!, forwardedArgv, {
  encoding: 'utf8',
  env: { ...process.env, PATH: process.env.WORKER_NATIVE_DELEGATE_PATH! },
});
const record = {
  argv,
  forwardedArgv,
  stdout: result.stdout ?? '',
  stderr: result.stderr ?? '',
  status: interrupted ? 125 : result.status,
  interrupted,
  error: result.error?.message,
};
appendFileSync(process.env.WORKER_NATIVE_TRACE!, JSON.stringify(record) + '\\n');
process.stdout.write(record.stdout);
process.stderr.write(record.stderr);
process.exitCode = interrupted ? 125 : result.status ?? 1;
`,
    );

    const envKeys = [
      'PATH',
      'GOAL_TASK_ID',
      'GOAL_ATTEMPT',
      'WORKER_NATIVE_REAL_DOCKER',
      'WORKER_NATIVE_DELEGATE_PATH',
      'WORKER_NATIVE_TRACE',
      'WORKER_NATIVE_INTERRUPT_MARKER',
      'WORKER_NATIVE_INTERRUPT_FIRST_RM',
    ];
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    const previousError = console.error;
    const errorMessages: string[] = [];
    const originalPath = process.env.PATH ?? '';
    const runId = randomUUID().replaceAll('-', '');
    const createdIds: string[] = [];
    const foreignIds: string[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const calls = (): DockerCall[] =>
      existsSync(traceFile)
        ? readFileSync(traceFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as DockerCall)
        : [];

    process.env.PATH = `${bin}:${originalPath}`;
    delete process.env.GOAL_TASK_ID;
    delete process.env.GOAL_ATTEMPT;
    process.env.WORKER_NATIVE_REAL_DOCKER = dockerPath!;
    process.env.WORKER_NATIVE_DELEGATE_PATH = originalPath;
    process.env.WORKER_NATIVE_TRACE = traceFile;
    process.env.WORKER_NATIVE_INTERRUPT_MARKER = interruptionMarker;
    delete process.env.WORKER_NATIVE_INTERRUPT_FIRST_RM;
    console.error = (message?: unknown) => errorMessages.push(String(message));

    function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
      const result = spawnSync('docker', args, { encoding: 'utf8' });
      if (result.error || result.status !== 0) {
        throw new Error(`docker ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
      }
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    function create(taskId: string, attempt: number, name: string): string {
      const result = docker([
        'create',
        '--name',
        `rezics-${runId}-${name}`,
        '--label',
        `${labelName}=${taskId}/${attempt}`,
        image,
        'true',
      ]);
      const id = ids(result.stdout).at(-1);
      if (!id) throw new Error('docker create returned no container ID');
      createdIds.push(id);
      return id;
    }

    function readCallsSince(index: number): DockerCall[] {
      return calls().slice(index);
    }

    function cleanup(taskId: string, attempt: number, owned: string[], foreignCount: number): Record<string, unknown> {
      const start = calls().length;
      removeAttemptContainers(taskId, attempt);
      const recorded = readCallsSince(start);
      expect(recorded.map((call) => call.argv[0])).toEqual(owned.length ? ['ps', 'rm'] : ['ps']);
      const query = recorded[0]!;
      expect(query.argv).toEqual(['ps', '-aq', '--filter', `label=${labelName}=${taskId}/${attempt}`]);
      expect(query.status).toBe(0);
      const returnedIds = ids(query.stdout);
      expectSameIds(returnedIds, owned);

      const removal = recorded[1];
      const removalArgs = removal?.argv.slice(3) ?? [];
      const removalOutput = removal ? ids(removal.stdout) : [];
      if (owned.length) {
        expect(removal?.status).toBe(0);
        expect(removal?.argv.slice(0, 3)).toEqual(['rm', '-f', '-v']);
        expect(removalArgs).toEqual(returnedIds);
        expect(removalOutput).toHaveLength(owned.length);
        expectSameIds(removalArgs, owned);
      } else {
        expect(removal).toBeUndefined();
      }
      if (foreignIds.length) {
        const foreign = docker(['inspect', '--format', '{{.Id}}', ...foreignIds]);
        expectSameIds(ids(foreign.stdout), foreignIds);
      }

      const observation = {
        taskId,
        attempt,
        foreignAttemptPopulation: foreignCount,
        selectedContainerCount: owned.length,
        calls: recorded.map(({ argv, forwardedArgv, status, stdout, interrupted }) => ({
          argv,
          forwardedArgv,
          status,
          stdout: stdout.trim(),
          interrupted,
        })),
        workUnits: {
          dockerCliInvocations: recorded.length,
          returnedContainerIds: returnedIds,
          removalRequestIds: removalArgs,
          removalResponseIds: removalOutput,
          daemonExaminedWork: 'unavailable from Docker CLI observations',
        },
      };
      observations.push(observation);
      return observation;
    }

    function assertForeignPopulation(count: number): void {
      for (let index = foreignIds.length; index < count; index += 1) {
        foreignIds.push(create(`foreign-${runId}-${index}`, 1, `foreign-${index}`));
      }
    }

    try {
      const fixedTask = `selected-${runId}`;
      let foreignCount = 0;
      for (const scale of [1, 10, 100]) {
        assertForeignPopulation(scale);
        foreignCount = scale;
        const selected = [
          create(fixedTask, 1, `fixed-${scale}-a`),
          create(fixedTask, 1, `fixed-${scale}-b`),
        ];
        cleanup(fixedTask, 1, selected, foreignCount);
      }

      for (const selectedCount of [1, 4, 16]) {
        const taskId = `selected-size-${runId}-${selectedCount}`;
        const selected = Array.from({ length: selectedCount }, (_, index) =>
          create(taskId, 1, `size-${selectedCount}-${index}`),
        );
        cleanup(taskId, 1, selected, foreignCount);
      }

      const replayTask = `selected-size-${runId}-16`;
      cleanup(replayTask, 1, [], foreignCount);

      const emptyTask = `empty-${runId}`;
      cleanup(emptyTask, 1, [], foreignCount);

      const interruptedTask = `interrupted-${runId}`;
      const interruptedIds = [
        create(interruptedTask, 1, 'interrupted-a'),
        create(interruptedTask, 1, 'interrupted-b'),
        create(interruptedTask, 1, 'interrupted-c'),
      ];
      const interruptedStart = calls().length;
      process.env.WORKER_NATIVE_INTERRUPT_FIRST_RM = '1';
      removeAttemptContainers(interruptedTask, 1);
      delete process.env.WORKER_NATIVE_INTERRUPT_FIRST_RM;
      const firstAttempt = readCallsSince(interruptedStart);
      expect(firstAttempt.map((call) => call.argv[0])).toEqual(['ps', 'rm']);
      expect(firstAttempt[0]!.status).toBe(0);
      const firstReturned = ids(firstAttempt[0]!.stdout);
      expectSameIds(firstReturned, interruptedIds);
      expect(firstAttempt[1]!.interrupted).toBe(true);
      expect(firstAttempt[1]!.status).toBe(125);
      expect(firstAttempt[1]!.argv.slice(3)).toEqual(firstReturned);
      expect(firstAttempt[1]!.forwardedArgv.slice(3)).toEqual([firstReturned[0]!]);
      expect(errorMessages.join('\n')).toContain(`${labelName}=${interruptedTask}/1`);
      const remaining = interruptedIds.filter((id) => {
        const inspect = spawnSync('docker', ['inspect', '--format', '{{.Id}}', id], { encoding: 'utf8' });
        return inspect.status === 0;
      });
      expectSameIds(remaining, interruptedIds.filter((id) => !sameId(firstAttempt[1]!.stdout.trim(), id)));
      observations.push({
        taskId: interruptedTask,
        attempt: 1,
        foreignAttemptPopulation: foreignCount,
        selectedContainerCount: interruptedIds.length,
        calls: firstAttempt.map(({ argv, forwardedArgv, status, stdout, interrupted }) => ({
          argv,
          forwardedArgv,
          status,
          stdout: stdout.trim(),
          interrupted,
        })),
        workUnits: {
          dockerCliInvocations: firstAttempt.length,
          returnedContainerIds: firstReturned,
          removalRequestIds: firstAttempt[1]!.argv.slice(3),
          removalResponseIds: ids(firstAttempt[1]!.stdout),
          daemonExaminedWork: 'unavailable from Docker CLI observations',
        },
      });
      cleanup(interruptedTask, 1, remaining, foreignCount);
      cleanup(interruptedTask, 1, [], foreignCount);

      console.info(
        `NATIVE_DOCKER_EVIDENCE ${JSON.stringify({
          fixtureForeignIds: foreignIds,
          observations,
          daemonExaminedWork: 'unavailable from Docker CLI observations',
        })}`,
      );
    } finally {
      delete process.env.WORKER_NATIVE_INTERRUPT_FIRST_RM;
      const remaining = createdIds.filter((id) => {
        const inspect = spawnSync('docker', ['inspect', '--format', '{{.Id}}', id], { encoding: 'utf8' });
        return inspect.status === 0;
      });
      if (remaining.length) spawnSync('docker', ['rm', '-f', '-v', ...remaining], { encoding: 'utf8' });
      console.error = previousError;
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
