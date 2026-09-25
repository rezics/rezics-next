import { expect, test } from 'bun:test';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';

test('OPS05: load inspection uses the daemon that stack startup can reach', () => {
  const env = { DOCKER_HOST: 'unix:///tmp/docker.sock', XDG_RUNTIME_DIR: '/tmp/runtime' };
  const seen: string[] = [];
  const probe = (candidate: NodeJS.ProcessEnv) => {
    seen.push(candidate.DOCKER_HOST ?? '');
    return candidate.DOCKER_HOST === env.DOCKER_HOST;
  };
  expect(loadDockerEnvironment(env, probe, () => true).DOCKER_HOST).toBe(env.DOCKER_HOST);
  expect(seen).toEqual([env.DOCKER_HOST]);
});

test('OPS05: unavailable Docker falls back only to a responding Podman socket', () => {
  const env = { XDG_RUNTIME_DIR: '/tmp/runtime' };
  const socket = 'unix:///tmp/runtime/podman/podman.sock';
  expect(loadDockerEnvironment(env, candidate => candidate.DOCKER_HOST === socket,
    path => path === '/tmp/runtime/podman/podman.sock').DOCKER_HOST).toBe(socket);
  expect(() => loadDockerEnvironment(env, () => false, () => true))
    .toThrow('Podman socket is not responding');
  expect(() => loadDockerEnvironment(env, () => false, () => false))
    .toThrow('No Docker-compatible daemon');
});
