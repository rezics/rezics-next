import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { standaloneFuseki, type StandaloneDockerExecutor, type StandaloneDockerResult } from '../fault-recovery/search-ops-support.ts';

const root = resolve(import.meta.dir, '../../..');
const scratch = mkdtempSync(join(root, '.temp', 'standalone-fuseki-stop-'));
const containerName = 'standalone-stop-unit';
const input = { name: containerName, image: 'fuseki:test', volume: 'fuseki-state', secrets: {
  FUSEKI_COMMAND_TOKEN: 'unit-secret-token-value',
} };

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function result(status = 0, stdout = '', stderr = ''): StandaloneDockerResult {
  return { status, stdout, stderr };
}

function createExecutor(respond: (args: string[], env: NodeJS.ProcessEnv, timeout: number) => StandaloneDockerResult) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; timeout: number }[] = [];
  const docker: StandaloneDockerExecutor = (args, env, timeout) => {
    calls.push({ args, env, timeout });
    return respond(args, env, timeout);
  };
  return { docker, calls };
}

async function standalone(docker: StandaloneDockerExecutor, artifactDir: string, now?: () => number) {
  mkdirSync(artifactDir, { recursive: true });
  return standaloneFuseki({ DOCKER_HOST: 'unix:///qa/docker.sock' }, input, {
    docker, artifactDir, waitForReady: async () => {}, ...(now ? { now } : {}),
  });
}

test('standalone creation grants Fuseki sixty seconds and stop records the successful client call', async () => {
  const artifactDir = join(scratch, 'success');
  const { docker, calls } = createExecutor(() => result());
  let at = 0;
  const graph = await standalone(docker, artifactDir, () => at += 25);

  graph.runner.stop();

  const creation = calls.find(call => call.args[0] === 'run')!;
  const stop = calls.find(call => call.args[0] === 'stop')!;
  expect(creation.args).toContain('--stop-timeout=60');
  expect(stop.args).toEqual(['stop', containerName]);
  expect(stop.timeout).toBe(90_000);
  expect(stop.env).toBe(creation.env);
  expect(readFileSync(join(artifactDir, `standalone-fuseki-stop-${containerName}.json`), 'utf8')).toContain(
    '"succeeded": true');
  const record = JSON.parse(readFileSync(join(artifactDir, `standalone-fuseki-stop-${containerName}.json`), 'utf8'));
  expect(record).toMatchObject({ container: containerName, durationMs: 25, succeeded: true });
});

test('readiness preserves the JVM refusal and redacts secrets before failed-copy disposal', async () => {
  const artifactDir = join(scratch, 'readiness');
  mkdirSync(artifactDir, { recursive: true });
  const readinessFailure = new Error('Fuseki did not become ready');
  const { docker, calls } = createExecutor(args => args[0] === 'logs'
    ? result(0, `Exception: incompatible retained source ${input.secrets.FUSEKI_COMMAND_TOKEN}`)
    : result());
  let allocated: Awaited<ReturnType<typeof standaloneFuseki>> | undefined;

  await expect(standaloneFuseki({}, input, {
    docker, artifactDir, onAllocated: graph => { allocated = graph; },
    waitForReady: async () => { throw readinessFailure; },
  })).rejects.toBe(readinessFailure);

  expect(allocated?.name).toBe(containerName);
  expect(calls.map(call => call.args[0])).toEqual(['run', 'logs']);
  expect(calls[1]?.timeout).toBe(5_000);
  const logs = readFileSync(join(artifactDir, `standalone-fuseki-readiness-${containerName}.log`), 'utf8');
  expect(logs).toContain('Exception: incompatible retained source');
  expect(logs).not.toContain(input.secrets.FUSEKI_COMMAND_TOKEN);

  await expect(allocated!.runner.start()).rejects.toBe(readinessFailure);
  expect(calls.map(call => call.args[0])).toEqual(['run', 'logs', 'start', 'logs']);
});

test('readiness preserves its failure when Docker cannot collect startup evidence', async () => {
  const readinessFailure = new Error('Fuseki did not become ready');
  const { docker, calls } = createExecutor(args => args[0] === 'logs'
    ? result(1, '', 'daemon unavailable') : result());

  await expect(standaloneFuseki({}, input, {
    docker, waitForReady: async () => { throw readinessFailure; },
  })).rejects.toBe(readinessFailure);

  expect(calls.map(call => call.args[0])).toEqual(['run', 'logs']);
});

test('stop preserves the daemon failure when bounded evidence commands fail', async () => {
  const artifactDir = join(scratch, 'failed-diagnostics');
  const daemonFailure = new Error(`docker stop failed: Error response from daemon: cannot stop container: ${containerName}: tried to kill container, but did not receive an exit event`);
  const { docker, calls } = createExecutor(args => {
    if (args[0] === 'stop') throw daemonFailure;
    if (args[0] === 'run') return result();
    throw new Error('diagnostic client unavailable');
  });
  const graph = await standalone(docker, artifactDir);

  let caught: unknown;
  try { graph.runner.stop(); } catch (error) { caught = error; }

  expect(caught).toBe(daemonFailure);
  expect(calls.find(call => call.args[0] === 'stop')?.timeout).toBe(90_000);
  const diagnostics = calls.filter(call => call.args[0] !== 'run' && call.args[0] !== 'stop');
  expect(diagnostics.map(call => call.args[0])).toEqual(['inspect', 'version', 'exec', 'logs']);
  expect(diagnostics.every(call => call.timeout <= 5_000 && call.env === calls[0]!.env)).toBe(true);
  const path = join(artifactDir, `standalone-fuseki-stop-${containerName}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  expect(record).toMatchObject({ container: containerName, succeeded: false });
  expect(record.error).toBe(daemonFailure.message);
  expect(record.diagnostics.errors).toHaveLength(4);
  expect(JSON.stringify(record)).not.toContain(input.secrets.FUSEKI_COMMAND_TOKEN);
});

test('failure evidence spends one five-second deadline across all Docker probes', async () => {
  const artifactDir = join(scratch, 'deadline');
  let at = 0;
  const diagnosticTimeouts: number[] = [];
  const { docker, calls } = createExecutor(args => {
    if (args[0] === 'run') return result();
    if (args[0] === 'stop') return result(1, '', 'Error response from daemon: stop failed');
    diagnosticTimeouts.push(calls.at(-1)!.timeout);
    at += 2_100;
    return result(0, 'bounded evidence');
  });
  const graph = await standalone(docker, artifactDir, () => at);

  expect(() => graph.runner.stop()).toThrow('Error response from daemon: stop failed');

  expect(diagnosticTimeouts).toEqual([5_000, 2_900, 800]);
  const record = JSON.parse(readFileSync(join(artifactDir, `standalone-fuseki-stop-${containerName}.json`), 'utf8'));
  expect(record.diagnostics).toMatchObject({ deadlineMs: 5_000, elapsedMs: 6_300, deadlineReached: true });
  expect(record.diagnostics.logTail).toBeNull();
});

test('remove reports Docker failures and accepts absence only after an inspect refusal names this container', async () => {
  const removalFailure = 'Error response from daemon: permission denied';
  const failedRemoval = async (inspectResult: StandaloneDockerResult) => {
    const { docker } = createExecutor(args => {
      if (args[0] === 'run') return result();
      if (args[0] === 'rm') return result(1, '', removalFailure);
      if (args[0] === 'inspect') return inspectResult;
      return result();
    });
    return standalone(docker, join(scratch, `remove-${Math.random().toString(16).slice(2)}`));
  };

  const stillOwned = await failedRemoval(result(0, 'container-id'));
  expect(() => stillOwned.remove()).toThrow(`docker rm failed: ${removalFailure}`);

  const absentDocker = await failedRemoval(result(1, '', `Error: No such object: ${containerName}`));
  expect(() => absentDocker.remove()).not.toThrow();

  const uncertain = await failedRemoval(result(0, ''));
  expect(() => uncertain.remove()).toThrow(`docker rm failed: ${removalFailure}`);
});
