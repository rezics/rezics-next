import { expect, test } from 'bun:test';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';

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
  expect(() => loadDockerEnvironment({ XDG_RUNTIME_DIR: '/tmp/runtime' }, candidate => {
    seen.push(candidate.DOCKER_HOST ?? '');
    return false;
  })).toThrow('Docker is unavailable');
  expect(seen).toEqual(['']);
});
