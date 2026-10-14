import { expect, test } from 'bun:test';
import { hostLoopbackAccess, loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';

function probeClock() {
  let elapsedMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => elapsedMs,
    advance: (milliseconds: number) => { elapsedMs += milliseconds; },
    sleeps,
    sleep: (milliseconds: number) => {
      sleeps.push(milliseconds);
      elapsedMs += milliseconds;
    },
  };
}

test('OPS05: load inspection uses the daemon that stack startup can reach', () => {
  const env = { DOCKER_HOST: 'unix:///tmp/docker.sock', XDG_RUNTIME_DIR: '/tmp/runtime' };
  const seen: string[] = [];
  const probe = (candidate: NodeJS.ProcessEnv) => {
    seen.push(candidate.DOCKER_HOST ?? '');
    return candidate.DOCKER_HOST === env.DOCKER_HOST;
  };
  expect(loadDockerEnvironment(env, probe).DOCKER_HOST).toBe(env.DOCKER_HOST);
  expect(seen).toEqual([env.DOCKER_HOST]);
});

test('OPS05: unavailable Docker fails instead of switching engines', () => {
  const seen: string[] = [];
  const clock = probeClock();
  expect(() => loadDockerEnvironment({ XDG_RUNTIME_DIR: '/tmp/runtime' }, candidate => {
    seen.push(candidate.DOCKER_HOST ?? '');
    return false;
  }, clock)).toThrow('Docker is unavailable');
  expect(seen.length).toBeGreaterThan(1);
  expect(seen.every(host => host === '')).toBe(true);
  expect(clock.now()).toBe(60_000);
  expect(clock.sleeps.slice(0, 4)).toEqual([250, 500, 1_000, 2_000]);
  expect(clock.sleeps.every(milliseconds => milliseconds <= 2_000)).toBe(true);
});

test('OPS05: a slow selected engine can answer after its first request times out', () => {
  const env = { DOCKER_HOST: 'unix:///tmp/docker.sock' };
  const clock = probeClock();
  const attempts: { host: string | undefined; timeoutMs: number }[] = [];
  const loaded = loadDockerEnvironment(env, (candidate, timeoutMs) => {
    attempts.push({ host: candidate.DOCKER_HOST, timeoutMs });
    clock.advance(10_000);
    return attempts.length === 1 ? undefined : '29.0.0';
  }, clock);
  expect(loaded.DOCKER_HOST).toBe(env.DOCKER_HOST);
  expect(attempts).toEqual([
    { host: env.DOCKER_HOST, timeoutMs: 10_000 },
    { host: env.DOCKER_HOST, timeoutMs: 10_000 },
  ]);
  expect(clock.sleeps).toEqual([250]);
  expect(clock.now()).toBe(20_250);
});

test('OPS05: a silent engine exhausts one deadline including requests and backoff', () => {
  const clock = probeClock();
  const timeouts: number[] = [];
  expect(() => loadDockerEnvironment({}, (_candidate, timeoutMs) => {
    timeouts.push(timeoutMs);
    clock.advance(timeoutMs);
    return undefined;
  }, clock)).toThrow('Docker is unavailable');
  expect(timeouts).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 4_250]);
  expect(clock.sleeps).toEqual([250, 500, 1_000, 2_000, 2_000]);
  expect(clock.now()).toBe(60_000);
});

test('OPS05: an engine answering with an empty version is unavailable immediately', () => {
  const clock = probeClock();
  let attempts = 0;
  expect(() => loadDockerEnvironment({}, () => {
    attempts += 1;
    return ' \n';
  }, clock)).toThrow('Docker is unavailable');
  expect(attempts).toBe(1);
  expect(clock.sleeps).toEqual([]);
});

test('OPS05: loopback access waits for a slow Docker Desktop without choosing native networking', () => {
  const clock = probeClock();
  const env = { DOCKER_HOST: 'unix:///tmp/desktop.sock' };
  const seen: (string | undefined)[] = [];
  const access = hostLoopbackAccess(env, (candidate, timeoutMs) => {
    seen.push(candidate.DOCKER_HOST);
    clock.advance(timeoutMs);
    return seen.length === 1 ? undefined : 'Docker Desktop';
  }, clock);
  expect(access).toEqual({ args: ['--add-host=host.docker.internal:host-gateway'], host: 'host.docker.internal' });
  expect(seen).toEqual([env.DOCKER_HOST, env.DOCKER_HOST]);
  expect(clock.now()).toBe(20_250);
});

test('OPS05: unavailable loopback information fails instead of assuming native networking', () => {
  const clock = probeClock();
  expect(() => hostLoopbackAccess({}, (_candidate, timeoutMs) => {
    clock.advance(timeoutMs);
    return undefined;
  }, clock)).toThrow('Docker is unavailable');
  expect(clock.now()).toBe(60_000);
});
