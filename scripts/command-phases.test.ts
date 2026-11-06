import { expect, test } from 'bun:test';
import {
  DOCKER_BUILD_TIMEOUT_MS,
  DOCKER_PROBE_TIMEOUT_MS,
  DOCKER_RUN_TIMEOUT_MS,
  dockerTimeoutMs,
} from './compiler-database.ts';
import { kernelLaunchCommand, SEEDED_WEB_READY_PATH, stackStartPlan } from './walk-stack.ts';

test('compiler, search and admitted-stack phases keep Docker run bounds and Kernel without watch', () => {
  expect(dockerTimeoutMs(['run', '-d', 'postgres'])).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(dockerTimeoutMs(['rm', '-f', '-v', 'x'])).toBe(DOCKER_RUN_TIMEOUT_MS);
  expect(dockerTimeoutMs(['build', '--tag', 'x', '.'])).toBe(DOCKER_BUILD_TIMEOUT_MS);
  expect(dockerTimeoutMs(['ps', '-a'])).toBe(DOCKER_PROBE_TIMEOUT_MS);
  const env = { REZICS_WALK_STACK_SLOT: '1' };
  const plan = stackStartPlan(env, {
    web: 'http://127.0.0.1:20000',
    issuer: 'http://127.0.0.1:20001',
    native: 'http://127.0.0.1:20002',
    kernel: 'http://127.0.0.1:20003',
  });
  expect(plan.deferPages).toBe(true);
  expect(plan.kernel).toEqual(kernelLaunchCommand(env));
  expect(plan.kernel.at(-1)).toBe('start');
  expect(plan.nativeReady[0]).toContain('/.well-known/jwks.json');
  expect(SEEDED_WEB_READY_PATH).toBe('/en');
});
