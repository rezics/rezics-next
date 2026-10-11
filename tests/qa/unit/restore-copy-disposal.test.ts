import { expect, test } from 'bun:test';
import {
  attemptRestoreCleanup,
  createRestoreCopyDisposal,
  createRestoreGraphResourceOwner,
} from '../fault-recovery/owner-restore-erasure-fixture.ts';
import {
  standaloneFuseki,
  type StandaloneDockerResult,
} from '../fault-recovery/search-ops-support.ts';

test('disposing a copy releases only its resources and is harmless when repeated', async () => {
  const resources = [
    'candidate pools',
    'candidate graph',
    'candidate PostgreSQL',
    'candidate retained relay database',
    'candidate graph volume',
    'candidate directories and objects',
  ];
  const candidate = new Set(resources);
  const retained = new Set(['source cut', 'immutable relay template', 'sibling copy']);
  const attempts: string[] = [];
  const dispose = createRestoreCopyDisposal(
    resources.map((resource) => ({
      resource,
      run: () => {
        attempts.push(resource);
        candidate.delete(resource);
      },
    })),
  );

  await dispose();

  expect(candidate.size).toBe(0);
  expect(retained).toEqual(new Set(['source cut', 'immutable relay template', 'sibling copy']));
  expect(attempts).toEqual(resources);

  await dispose();

  expect(attempts).toEqual(resources);
});

test('final cleanup owns a graph created before readiness fails and retries checked removal', async () => {
  const resources = createRestoreGraphResourceOwner();
  const input = {
    name: 'restore-copy-startup-fault',
    image: 'fuseki:test',
    volume: 'restore-copy-startup-fault-volume',
    secrets: { FUSEKI_COMMAND_TOKEN: 'unit-secret-token-value' },
  };
  const state = {
    candidateGraph: false,
    candidateVolume: false,
    sourceCut: true,
    immutableRelayTemplate: true,
    siblingCopy: true,
  };
  const calls: string[][] = [];
  let removalAttempts = 0;
  const docker = (args: string[]): StandaloneDockerResult => {
    calls.push(args);
    if (args[0] === 'run') {
      state.candidateGraph = true;
      return { status: 0, stdout: 'container-id', stderr: '' };
    }
    if (args[0] === 'rm') {
      removalAttempts++;
      if (removalAttempts === 1) return { status: 1, stdout: '', stderr: 'temporary Docker removal fault' };
      state.candidateGraph = false;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'inspect')
      return { status: 0, stdout: state.candidateGraph ? 'container-id' : '', stderr: '' };
    if (args[0] === 'volume' && args[1] === 'create') {
      state.candidateVolume = true;
      return { status: 0, stdout: input.volume, stderr: '' };
    }
    if (args[0] === 'volume' && args[1] === 'rm') {
      state.candidateVolume = false;
      return { status: 0, stdout: input.volume, stderr: '' };
    }
    throw new Error(`unexpected Docker command: ${args[0]}`);
  };
  const env = { DOCKER_HOST: 'unix:///qa/docker.sock' };

  resources.registerVolume(input.volume);
  docker(['volume', 'create', input.volume]);
  await expect(standaloneFuseki(env, input, {
    docker: (args) => docker(args),
    waitForReady: async () => {
      throw new Error('readiness fault');
    },
    onCreated: resources.registerContainer,
  })).rejects.toThrow('readiness fault');

  expect(resources.containers.map(({ name }) => name)).toEqual([input.name]);
  expect(resources.volumes).toEqual([input.volume]);
  expect(state.candidateGraph).toBe(true);
  expect(state.candidateVolume).toBe(true);

  const removeVolume = (name: string) => {
    const result = docker(['volume', 'rm', '-f', name]);
    if (result.status !== 0) throw new Error('Docker volume removal failed');
    resources.unregisterVolume(name);
  };
  const firstFailures = await attemptRestoreCleanup([
    ...resources.containerCleanupActions(),
    ...resources.volumeCleanupActions(removeVolume),
  ]);

  expect(firstFailures.map(({ action }) => action.resource)).toEqual([
    `Fuseki container ${input.name}`,
  ]);
  expect(resources.containers.map(({ name }) => name)).toEqual([input.name]);
  expect(resources.volumes).toEqual([]);
  expect(state.candidateGraph).toBe(true);
  expect(state.candidateVolume).toBe(false);
  expect(state).toMatchObject({ sourceCut: true, immutableRelayTemplate: true, siblingCopy: true });

  const finalFailures = await attemptRestoreCleanup([
    ...resources.containerCleanupActions(),
    ...resources.volumeCleanupActions(removeVolume),
  ]);

  expect(finalFailures).toEqual([]);
  expect(resources.containers).toEqual([]);
  expect(resources.volumes).toEqual([]);
  expect(state.candidateGraph).toBe(false);
  expect(state.candidateVolume).toBe(false);
  expect(state).toMatchObject({ sourceCut: true, immutableRelayTemplate: true, siblingCopy: true });
  expect(removalAttempts).toBe(2);
  expect(calls.filter(([command]) => command === 'ps')).toEqual([]);
});

test('partial disposal reports failures and retries only resources still owned', async () => {
  const resources = ['candidate pools', 'candidate graph', 'candidate PostgreSQL', 'candidate files'];
  const outstanding = new Set(resources);
  const failOnce = new Set(['candidate graph']);
  const attempts = new Map<string, number>();
  const dispose = createRestoreCopyDisposal(
    resources.map((resource) => ({
      resource,
      run: () => {
        attempts.set(resource, (attempts.get(resource) ?? 0) + 1);
        if (failOnce.has(resource)) {
          failOnce.delete(resource);
          throw new Error(`${resource} removal fault`);
        }
        outstanding.delete(resource);
      },
    })),
  );

  await expect(dispose()).rejects.toThrow('restore copy disposal failed');

  expect(outstanding).toEqual(new Set(['candidate graph']));
  expect([...attempts.keys()]).toEqual(resources);

  await dispose();

  expect(outstanding.size).toBe(0);
  expect(attempts.get('candidate pools')).toBe(1);
  expect(attempts.get('candidate graph')).toBe(2);
  expect(attempts.get('candidate PostgreSQL')).toBe(1);
  expect(attempts.get('candidate files')).toBe(1);
});
