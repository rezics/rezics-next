import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertIndependentRestoreSourceAbsent,
  disposeIndependentRestoreSource,
  inspectIndependentRestoreTarget,
  recordIndependentRestoreSourceInventory,
  type IsolationContainer,
  type IsolationInspector,
  type IsolationNetwork,
} from '../../../tests/qa/fault-recovery/independent-restore-support.ts';
import { assertFreshTarget } from '../recovery-set.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');

type FakeState = {
  containers: IsolationContainer[];
  volumes: { project: string; name: string }[];
  networks: (IsolationNetwork & { project: string })[];
};

function fixtureProject(): string {
  return `rezics-qa-isolation-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function sourceFixture(state = 'running') {
  const project = fixtureProject();
  const stackDirectory = join(repositoryRoot, '.temp', 'stack', project);
  const objectDirectory = join(stackDirectory, 'objects');
  mkdirSync(objectDirectory, { recursive: true, mode: 0o700 });
  const sourceNetwork = {
    id: randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
    name: `${project}_default`,
  };
  const containers: IsolationContainer[] = ['postgres', 'fuseki', 'rustfs'].map((service, index) => ({
    id: `${String(index + 1).repeat(64)}`,
    name: `${project}-${service}-1`,
    state,
    project,
    service,
    mounts: [
      {
        type: 'volume',
        name: `${project}_${service === 'postgres' ? 'postgres' : service === 'fuseki' ? 'fuseki' : 'rustfs'}_data`,
        source: `/var/lib/docker/volumes/${project}_${service}_data/_data`,
        destination: service === 'postgres' ? '/var/lib/postgresql' : service === 'fuseki' ? '/fuseki/databases' : '/data',
      },
      ...(service === 'postgres'
        ? [{ type: 'bind', source: join(repositoryRoot, 'infra/dev/postgres/00-owners.sh'), destination: '/docker-entrypoint-initdb.d/00-owners.sh' }]
        : []),
    ],
    networkIds: [sourceNetwork.id],
  }));
  const stateData: FakeState = {
    containers,
    volumes: ['postgres_data', 'fuseki_data', 'rustfs_data'].map((kind) => ({ project, name: `${project}_${kind}` })),
    networks: [{ ...sourceNetwork, project, containerIds: containers.map((container) => container.id) }],
  };
  const inspector: IsolationInspector = {
    projectContainers: (name) => stateData.containers.filter((container) => container.project === name),
    projectVolumes: (name) => stateData.volumes.filter((volume) => volume.project === name).map((volume) => volume.name),
    projectNetworks: (name) => stateData.networks.filter((network) => network.project === name),
    containerPresent: (idOrName) => stateData.containers.some((container) =>
      container.id === idOrName || container.name === idOrName),
    volumePresent: (name) => stateData.volumes.some((volume) => volume.name === name),
    networkPresent: (idOrName) => stateData.networks.some((network) =>
      network.id === idOrName || network.name === idOrName),
  };
  const inventory = recordIndependentRestoreSourceInventory(project, stackDirectory, objectDirectory, inspector);
  return { project, stackDirectory, objectDirectory, stateData, inspector, inventory };
}

function disposeSource(fixture: ReturnType<typeof sourceFixture>): void {
  disposeIndependentRestoreSource(
    fixture.inventory,
    {
      compose: (args) => {
        expect(args).toEqual(['down', '--volumes', '--remove-orphans']);
        fixture.stateData.containers = fixture.stateData.containers.filter((container) =>
          container.project !== fixture.project);
        fixture.stateData.volumes = fixture.stateData.volumes.filter((volume) =>
          volume.project !== fixture.project);
        fixture.stateData.networks = fixture.stateData.networks.filter((network) =>
          network.project !== fixture.project);
      },
    },
    fixture.inspector,
  );
}

function targetContainers(project: string, networkId: string) {
  const services = [
    ['postgres', 'postgres_data', '/var/lib/postgresql'],
    ['fuseki', 'fuseki_data', '/fuseki/databases'],
    ['rustfs', 'rustfs_data', '/data'],
  ] as const;
  return services.map(([service, kind, destination], index): IsolationContainer => ({
    id: `${String(index + 4).repeat(64)}`,
    name: `${project}-${service}-1`,
    state: 'running',
    project,
    service,
    mounts: [
      {
        type: 'volume',
        name: `${project}_${kind}`,
        source: `/var/lib/docker/volumes/${project}_${kind}/_data`,
        destination,
      },
      ...(service === 'postgres'
        ? [{ type: 'bind', source: join(repositoryRoot, 'infra/dev/postgres/00-owners.sh'), destination: '/docker-entrypoint-initdb.d/00-owners.sh' }]
        : []),
    ],
    networkIds: [networkId],
  }));
}

function installTargetInspection(
  fixture: ReturnType<typeof sourceFixture>,
  project: string,
  containers: IsolationContainer[],
  network: IsolationNetwork,
): void {
  fixture.stateData.containers.push(...containers);
  fixture.stateData.networks.push({ ...network, project });
}

test('source inventory blocks both live and stopped sources while their volumes remain', () => {
  for (const state of ['running', 'exited']) {
    const fixture = sourceFixture(state);
    try {
      expect(fixture.inventory.containers.every((container) => container.state === state)).toBe(true);
      expect(fixture.inspector.volumePresent(fixture.inventory.volumes[0]!)).toBe(true);
      expect(() => assertIndependentRestoreSourceAbsent(fixture.inventory, fixture.inspector))
        .toThrow('Recorded source container remains');
    } finally {
      rmSync(fixture.stackDirectory, { recursive: true, force: true });
    }
  }
});

test('source inventory rejects detached containers when a retained source volume still exists', () => {
  const fixture = sourceFixture('exited');
  try {
    fixture.stateData.containers = [];
    fixture.stateData.networks = [];
    expect(fixture.inspector.volumePresent(fixture.inventory.volumes[0]!)).toBe(true);
    expect(() => assertIndependentRestoreSourceAbsent(fixture.inventory, fixture.inspector))
      .toThrow(`Recorded source volume remains: ${fixture.inventory.volumes[0]}`);
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('source disposal uses its stack owner and preserves an unrelated retained project', () => {
  const fixture = sourceFixture('exited');
  const unrelated = {
    id: 'f'.repeat(64),
    name: 'rezics-fixture-retained-postgres-1',
    state: 'exited',
    project: 'rezics-fixture-retained',
    service: 'postgres',
    mounts: [],
    networkIds: [],
  } satisfies IsolationContainer;
  fixture.stateData.containers.push(unrelated);
  fixture.stateData.volumes.push({ project: 'rezics-fixture-retained', name: 'rezics-fixture-retained_postgres_data' });
  const unrelatedNetwork: IsolationNetwork & { project: string } = {
    id: 'e'.repeat(64),
    name: 'rezics-fixture-retained_default',
    project: 'rezics-fixture-retained',
    containerIds: [unrelated.id],
  };
  fixture.stateData.networks.push(unrelatedNetwork);
  try {
    disposeSource(fixture);
    expect(fixture.inspector.containerPresent(unrelated.id)).toBe(true);
    expect(fixture.inspector.volumePresent('rezics-fixture-retained_postgres_data')).toBe(true);
    expect(fixture.inspector.networkPresent(unrelatedNetwork.id)).toBe(true);
    expect(fixture.inspector.projectContainers(fixture.project)).toEqual([]);
    expect(fixture.inspector.projectVolumes(fixture.project)).toEqual([]);
    expect(fixture.inspector.projectNetworks(fixture.project)).toEqual([]);
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('source removal failure propagates before source files are deleted', () => {
  const fixture = sourceFixture();
  try {
    expect(() => disposeIndependentRestoreSource(
      fixture.inventory,
      { compose: () => { throw new Error('Compose source removal failed'); } },
      fixture.inspector,
    )).toThrow('Compose source removal failed');
    expect(fixture.inspector.containerPresent(fixture.inventory.containers[0]!.id)).toBe(true);
    expect(fixture.inspector.volumePresent(fixture.inventory.volumes[0]!)).toBe(true);
    expect(existsSync(fixture.stackDirectory)).toBe(true);
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('source disposal refuses resources added after the recorded inventory', () => {
  const fixture = sourceFixture();
  const unexpected: IsolationContainer = {
    id: '9'.repeat(64),
    name: `${fixture.project}-unexpected-1`,
    state: 'exited',
    project: fixture.project,
    service: 'unexpected',
    mounts: [],
    networkIds: [],
  };
  fixture.stateData.containers.push(unexpected);
  let ownerCalled = false;
  try {
    expect(() => disposeIndependentRestoreSource(
      fixture.inventory,
      { compose: () => { ownerCalled = true; } },
      fixture.inspector,
    )).toThrow('Source inventory changed before disposal');
    expect(ownerCalled).toBe(false);
    expect(fixture.inspector.containerPresent(unexpected.id)).toBe(true);
    expect(existsSync(fixture.stackDirectory)).toBe(true);
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('production restore guard refuses the original project and an occupied target', () => {
  const source = 'rezics-qa-isolation-source';
  expect(() => assertFreshTarget('rezics-qa-isolation-successor', { source }, () => false)).not.toThrow();
  expect(() => assertFreshTarget(source, { source }, () => false)).toThrow('new empty isolated');
  expect(() => assertFreshTarget('rezics-qa-isolation-occupied', { source }, () => true))
    .toThrow('new empty isolated');
});

test('local target inspection accepts new storage and rejects source aliases and peers', () => {
  const fixture = sourceFixture('exited');
  const target = 'rezics-qa-isolation-successor';
  const network: IsolationNetwork = {
    id: 'e'.repeat(64),
    name: `${target}_default`,
    containerIds: [],
  };
  try {
    disposeSource(fixture);
    const containers = targetContainers(target, network.id);
    const validNetwork = { ...network, containerIds: containers.map((container) => container.id) };
    installTargetInspection(fixture, target, containers, validNetwork);
    expect(() => inspectIndependentRestoreTarget(target, fixture.inventory, fixture.inspector)).not.toThrow();

    const aliasedVolume = {
      ...containers[0]!,
      mounts: [...containers[0]!.mounts, {
        type: 'volume',
        name: fixture.inventory.volumes[0]!,
        source: `/var/lib/docker/volumes/${fixture.inventory.volumes[0]}/_data`,
        destination: '/source-alias',
      }],
    };
    fixture.stateData.containers = fixture.stateData.containers.filter((container) => container.id !== containers[0]!.id);
    fixture.stateData.containers.push(aliasedVolume);
    expect(() => inspectIndependentRestoreTarget(target, fixture.inventory, fixture.inspector))
      .toThrow('aliases recorded source volume');

    const aliasedBind = {
      ...containers[1]!,
      mounts: [...containers[1]!.mounts, {
        type: 'bind',
        source: fixture.inventory.bindMounts[0]!.source,
        destination: '/source-config',
      }],
    };
    fixture.stateData.containers = containers.filter((container) => container.id !== containers[1]!.id);
    fixture.stateData.containers.push(aliasedBind);
    expect(() => inspectIndependentRestoreTarget(target, fixture.inventory, fixture.inspector))
      .toThrow('aliases a source bind path');

    fixture.stateData.containers = containers;
    fixture.stateData.networks = fixture.stateData.networks.map((candidate) =>
      candidate.name === validNetwork.name
        ? { ...candidate, containerIds: [...validNetwork.containerIds, fixture.inventory.containers[0]!.id] }
        : candidate);
    expect(() => inspectIndependentRestoreTarget(target, fixture.inventory, fixture.inspector))
      .toThrow('includes a recorded source peer');
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});
