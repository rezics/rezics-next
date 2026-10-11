import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertIndependentRestoreSourceAbsent,
  disposeIndependentRestoreSource,
  inspectIndependentRestoreTarget,
  recordIndependentRestoreSourceInventory,
  RecoveryRefusal,
  type IsolationContainer,
  type IsolationInspector,
  type IsolationNetwork,
} from '../../../tests/qa/fault-recovery/independent-restore-support.ts';
import { assertFreshTarget } from '../recovery-set.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');

type FakeState = {
  containers: IsolationContainer[];
  volumes: { project?: string; name: string; source: string }[];
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
    networkAliases: [`${project}-${service}-1`, service],
    links: [],
    publishedPorts: [{
      containerPort: service === 'postgres' ? '5432/tcp' : service === 'fuseki' ? '3030/tcp' : '9000/tcp',
      hostIp: '127.0.0.1',
      hostPort: service === 'postgres' ? '25432' : service === 'fuseki' ? '23030' : '29000',
    }],
    environment: [],
    command: [],
    labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.service': service,
    },
  }));
  const stateData: FakeState = {
    containers,
    // Fixture-restored volumes were created by `docker volume create`, so they
    // have no Compose project label even though these containers mount them.
    volumes: ['postgres_data', 'fuseki_data', 'rustfs_data'].map((kind) => ({
      name: `${project}_${kind}`,
      source: `/var/lib/docker/volumes/${project}_${kind}/_data`,
    })),
    networks: [{ ...sourceNetwork, project, containerIds: containers.map((container) => container.id) }],
  };
  const inspector: IsolationInspector = {
    projectContainers: (name) => stateData.containers.filter((container) => container.project === name),
    projectLabeledVolumes: (name) => stateData.volumes.filter((volume) => volume.project === name).map((volume) => volume.name),
    projectNetworks: (name) => stateData.networks.filter((network) => network.project === name),
    volumeSource: (name) => {
      const volume = stateData.volumes.find((candidate) => candidate.name === name);
      if (!volume) throw new Error(`Fake volume backing path is unavailable: ${name}`);
      return volume.source;
    },
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
        const ownedVolumes = new Set(fixture.inventory.volumes);
        fixture.stateData.volumes = fixture.stateData.volumes.filter((volume) => !ownedVolumes.has(volume.name));
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
    networkAliases: [`${project}-${service}-1`, service],
    links: [],
    publishedPorts: [],
    environment: [],
    command: [],
    labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.service': service,
    },
  }));
}

function installTargetInspection(
  fixture: ReturnType<typeof sourceFixture>,
  project: string,
  containers: IsolationContainer[],
  network: IsolationNetwork,
): void {
  fixture.stateData.containers.push(...containers);
  for (const mount of containers.flatMap((container) => container.mounts)
    .filter((candidate) => candidate.type === 'volume' && candidate.name)) {
    if (!fixture.stateData.volumes.some((volume) => volume.name === mount.name)) {
      fixture.stateData.volumes.push({
        project,
        name: mount.name!,
        source: mount.source,
      });
    }
  }
  fixture.stateData.networks.push({ ...network, project });
}

function installedTargetFixture() {
  const fixture = sourceFixture('exited');
  const target = 'rezics-qa-isolation-successor';
  const network: IsolationNetwork = {
    id: 'e'.repeat(64),
    name: `${target}_default`,
    containerIds: [],
  };
  disposeSource(fixture);
  const containers = targetContainers(target, network.id);
  const validNetwork = { ...network, containerIds: containers.map((container) => container.id) };
  installTargetInspection(fixture, target, containers, validNetwork);
  return { fixture, target, containers, network: validNetwork };
}

function expectTargetRefusal(fixture: ReturnType<typeof sourceFixture>, target: string): RecoveryRefusal {
  let failure: unknown;
  try {
    inspectIndependentRestoreTarget(target, fixture.inventory, fixture.inspector);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RecoveryRefusal);
  const refusal = failure as RecoveryRefusal;
  expect(refusal.code).toBe('TARGET_IDENTITY_REFUSED');
  return refusal;
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

test('fixture-restored source inventory records and removes unlabeled volumes through its stack owner', () => {
  const fixture = sourceFixture('exited');
  const unrelated = {
    id: 'f'.repeat(64),
    name: 'rezics-fixture-retained-postgres-1',
    state: 'exited',
    project: 'rezics-fixture-retained',
    service: 'postgres',
    mounts: [],
    networkIds: [],
    networkAliases: [],
    links: [],
    publishedPorts: [],
    environment: [],
    command: [],
    labels: {
      'com.docker.compose.project': 'rezics-fixture-retained',
      'com.docker.compose.service': 'postgres',
    },
  } satisfies IsolationContainer;
  fixture.stateData.containers.push(unrelated);
  fixture.stateData.volumes.push({
    project: 'rezics-fixture-retained',
    name: 'rezics-fixture-retained_postgres_data',
    source: '/var/lib/docker/volumes/rezics-fixture-retained_postgres_data/_data',
  });
  const unrelatedNetwork: IsolationNetwork & { project: string } = {
    id: 'e'.repeat(64),
    name: 'rezics-fixture-retained_default',
    project: 'rezics-fixture-retained',
    containerIds: [unrelated.id],
  };
  fixture.stateData.networks.push(unrelatedNetwork);
  try {
    expect(fixture.inspector.projectLabeledVolumes(fixture.project)).toEqual([]);
    expect(fixture.inventory.volumes).toEqual([
      `${fixture.project}_fuseki_data`,
      `${fixture.project}_postgres_data`,
      `${fixture.project}_rustfs_data`,
    ]);
    expect(fixture.inventory.volumes.every((volume) => fixture.inspector.volumePresent(volume))).toBe(true);

    disposeSource(fixture);
    expect(fixture.inventory.volumes.every((volume) => !fixture.inspector.volumePresent(volume))).toBe(true);
    expect(() => assertIndependentRestoreSourceAbsent(fixture.inventory, fixture.inspector)).not.toThrow();
    expect(fixture.inspector.containerPresent(unrelated.id)).toBe(true);
    expect(fixture.inspector.volumePresent('rezics-fixture-retained_postgres_data')).toBe(true);
    expect(fixture.inspector.networkPresent(unrelatedNetwork.id)).toBe(true);
    expect(fixture.inspector.projectContainers(fixture.project)).toEqual([]);
    expect(fixture.inspector.projectLabeledVolumes(fixture.project)).toEqual([]);
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
    networkAliases: [],
    links: [],
    publishedPorts: [],
    environment: [],
    command: [],
    labels: {
      'com.docker.compose.project': fixture.project,
      'com.docker.compose.service': 'unexpected',
    },
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
  const source = 'rezics-qa-src';
  expect(() => assertFreshTarget('rezics-qa-src-new', { source }, () => false)).not.toThrow();
  expect(() => assertFreshTarget(source, { source }, () => false)).toThrow('new empty isolated');
  expect(() => assertFreshTarget('rezics-qa-isolation-occupied', { source }, () => true))
    .toThrow('new empty isolated');
});

test('local target inspection compares project labels exactly when the target extends the source name', () => {
  const fixture = sourceFixture('exited');
  const source = { ...fixture.inventory, project: 'rezics-qa-src' };
  const target = 'rezics-qa-src-new';
  const network: IsolationNetwork = {
    id: 'e'.repeat(64),
    name: `${target}_default`,
    containerIds: [],
  };
  try {
    disposeSource(fixture);
    const containers = targetContainers(target, network.id);
    installTargetInspection(fixture, target, containers, {
      ...network,
      containerIds: containers.map((container) => container.id),
    });
    expect(() => inspectIndependentRestoreTarget(target, source, fixture.inspector)).not.toThrow();
    expect(() => inspectIndependentRestoreTarget(source.project, source, fixture.inspector))
      .toThrow('distinct from the source');
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses a retained fixture volume beside its expected volume', () => {
  const { fixture, target, containers } = installedTargetFixture();
  const retainedName = 'rezics-fixture-retained_postgres_data';
  try {
    const retainedSource = `/var/lib/docker/volumes/${retainedName}/_data`;
    fixture.stateData.volumes.push({ project: 'rezics-fixture-retained', name: retainedName, source: retainedSource });
    const polluted = {
      ...containers[0]!,
      mounts: [...containers[0]!.mounts, {
        type: 'volume',
        name: retainedName,
        source: retainedSource,
        destination: '/retained-fixture',
      }],
    };
    fixture.stateData.containers = [polluted, ...containers.slice(1)];
    expect(() => inspectIndependentRestoreTarget(target, fixture.inventory, fixture.inspector))
      .toThrow('unapproved volume mount');
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses a bind mount of a source volume backing directory', () => {
  const { fixture, target, containers } = installedTargetFixture();
  try {
    const polluted = {
      ...containers[1]!,
      mounts: [...containers[1]!.mounts, {
        type: 'bind',
        source: fixture.inventory.volumeMounts[0]!.source,
        destination: '/source-volume',
      }],
    };
    fixture.stateData.containers = [containers[0]!, polluted, containers[2]!];
    expect(() => inspectIndependentRestoreTarget(target, fixture.inventory, fixture.inspector))
      .toThrow('aliases recorded source volume backing path');
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses an unapproved host path bind mount', () => {
  const { fixture, target, containers } = installedTargetFixture();
  try {
    const polluted = {
      ...containers[1]!,
      mounts: [...containers[1]!.mounts, {
        type: 'bind',
        source: join(repositoryRoot, 'README.md'),
        destination: '/host-path',
      }],
    };
    fixture.stateData.containers = [containers[0]!, polluted, containers[2]!];
    expect(() => inspectIndependentRestoreTarget(target, fixture.inventory, fixture.inspector))
      .toThrow('unapproved bind mount');
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses a source-specific bootstrap bind at the shared destination', () => {
  const fixture = sourceFixture('exited');
  const sourceSpecificBind = join(fixture.stackDirectory, '..', `${fixture.project}-owners.sh`);
  const bootstrapDestination = '/docker-entrypoint-initdb.d/00-owners.sh';
  try {
    writeFileSync(sourceSpecificBind, '# source-specific bootstrap\n');
    fixture.stateData.containers = fixture.stateData.containers.map((container) => container.service === 'postgres'
      ? {
          ...container,
          mounts: container.mounts.map((mount) => mount.destination === bootstrapDestination
            ? { ...mount, source: sourceSpecificBind }
            : mount),
        }
      : container);
    fixture.inventory = recordIndependentRestoreSourceInventory(
      fixture.project,
      fixture.stackDirectory,
      fixture.objectDirectory,
      fixture.inspector,
    );
    disposeSource(fixture);

    const target = 'rezics-qa-isolation-bootstrap';
    const network: IsolationNetwork = {
      id: 'e'.repeat(64),
      name: `${target}_default`,
      containerIds: [],
    };
    const containers = targetContainers(target, network.id).map((container) => container.service === 'postgres'
      ? {
          ...container,
          mounts: container.mounts.map((mount) => mount.destination === bootstrapDestination
            ? { ...mount, source: sourceSpecificBind }
            : mount),
        }
      : container);
    installTargetInspection(fixture, target, containers, {
      ...network,
      containerIds: containers.map((container) => container.id),
    });
    expect(expectTargetRefusal(fixture, target).message).toContain('aliases a source bind path');
  } finally {
    rmSync(sourceSpecificBind, { force: true });
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
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
    const foreignPeer: IsolationContainer = {
      id: 'b'.repeat(64),
      name: 'rezics-fixture-retained-worker-1',
      state: 'running',
      project: 'rezics-fixture-retained',
      service: 'worker',
      mounts: [],
      networkIds: [validNetwork.id],
      networkAliases: ['retained-worker'],
      links: [],
      publishedPorts: [],
      environment: [],
      command: [],
      labels: {
        'com.docker.compose.project': 'rezics-fixture-retained',
        'com.docker.compose.service': 'worker',
      },
    };
    fixture.stateData.containers.push(foreignPeer);
    fixture.stateData.networks = fixture.stateData.networks.map((candidate) =>
      candidate.name === validNetwork.name
        ? { ...candidate, containerIds: [...validNetwork.containerIds, foreignPeer.id] }
        : candidate);
    expect(() => inspectIndependentRestoreTarget(target, fixture.inventory, fixture.inspector))
      .toThrow('peer set differs from its storage containers');
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses a target container attached to an extra network', () => {
  const { fixture, target, containers, network } = installedTargetFixture();
  const extraNetwork: IsolationNetwork & { project: string } = {
    id: 'd'.repeat(64),
    name: `${target}_extra`,
    project: target,
    containerIds: [containers[0]!.id],
  };
  try {
    fixture.stateData.networks.push(extraNetwork);
    fixture.stateData.containers = containers.map((container) => container.id === containers[0]!.id
      ? { ...container, networkIds: [network.id, extraNetwork.id] }
      : container);
    expectTargetRefusal(fixture, target);
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses a foreign peer on the default network', () => {
  const { fixture, target, containers, network } = installedTargetFixture();
  const foreign: IsolationContainer = {
    id: 'b'.repeat(64),
    name: 'rezics-fixture-retained-worker-1',
    state: 'running',
    project: 'rezics-fixture-retained',
    service: 'worker',
    mounts: [],
    networkIds: [network.id],
    networkAliases: ['retained-worker'],
    links: [],
    publishedPorts: [],
    environment: [],
    command: [],
    labels: {
      'com.docker.compose.project': 'rezics-fixture-retained',
      'com.docker.compose.service': 'worker',
    },
  };
  try {
    fixture.stateData.containers.push(foreign);
    fixture.stateData.networks = fixture.stateData.networks.map((candidate) => candidate.id === network.id
      ? { ...candidate, containerIds: [...containers.map((container) => container.id), foreign.id] }
      : candidate);
    expectTargetRefusal(fixture, target);
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses attachment to the retained fixture network', () => {
  const { fixture, target, containers, network } = installedTargetFixture();
  const retainedNetwork: IsolationNetwork & { project: string } = {
    id: 'c'.repeat(64),
    name: 'rezics-fixture-retained_default',
    project: 'rezics-fixture-retained',
    containerIds: [containers[1]!.id],
  };
  try {
    fixture.stateData.networks.push(retainedNetwork);
    fixture.stateData.containers = containers.map((container) => container.id === containers[1]!.id
      ? { ...container, networkIds: [network.id, retainedNetwork.id] }
      : container);
    expectTargetRefusal(fixture, target);
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses source host ports, links and network aliases', () => {
  const { fixture, target, containers } = installedTargetFixture();
  const sourceContainer = fixture.inventory.containers[0]!;
  const sourcePort = fixture.inventory.publishedPorts[0]!;
  const cases: { service: string; change: Partial<IsolationContainer> }[] = [
    {
      service: 'postgres',
      change: {
        publishedPorts: [{
          containerPort: sourcePort.containerPort,
          hostIp: sourcePort.hostIp,
          hostPort: sourcePort.hostPort,
        }],
      },
    },
    { service: 'fuseki', change: { links: [`/${sourceContainer.name}:source`] } },
    { service: 'rustfs', change: { networkAliases: [sourceContainer.name] } },
  ];
  try {
    for (const candidate of cases) {
      const original = containers.find((container) => container.service === candidate.service)!;
      fixture.stateData.containers = containers.map((container) =>
        container.id === original.id ? { ...container, ...candidate.change } : container);
      expectTargetRefusal(fixture, target);
    }
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses source identities in environment, command and labels', () => {
  const { fixture, target, containers } = installedTargetFixture();
  const cases: { change: Partial<IsolationContainer> }[] = [
    { change: { environment: [`RESTORE_SOURCE_PROJECT=${fixture.inventory.project}`] } },
    { change: { command: [`--volume=${fixture.inventory.volumes[0]}`] } },
    {
      change: {
        labels: {
          ...containers[0]!.labels,
          'restore.source-network': fixture.inventory.networks[0]!.name,
        },
      },
    },
  ];
  try {
    for (const candidate of cases) {
      fixture.stateData.containers = containers.map((container, index) =>
        index === 0 ? { ...container, ...candidate.change } : container);
      expectTargetRefusal(fixture, target);
    }
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});

test('local target inspection refuses a still-running recorded source container', () => {
  const fixture = sourceFixture('running');
  const target = 'rezics-qa-isolation-successor';
  const network: IsolationNetwork = {
    id: 'e'.repeat(64),
    name: `${target}_default`,
    containerIds: [],
  };
  const containers = targetContainers(target, network.id);
  try {
    installTargetInspection(fixture, target, containers, {
      ...network,
      containerIds: containers.map((container) => container.id),
    });
    const refusal = expectTargetRefusal(fixture, target);
    expect(refusal.message).toContain('recorded source container remains');
  } finally {
    rmSync(fixture.stackDirectory, { recursive: true, force: true });
  }
});
