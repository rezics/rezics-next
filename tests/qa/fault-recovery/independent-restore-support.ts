import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { Pool } from 'pg';
import { artifactNames, RecoveryRefusal } from '../../../scripts/ops/recovery-set.ts';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { startPostgresCluster } from '../support/postgres-cluster.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const sharedPostgresBootstrapPath = realpathSync(join(repositoryRoot, 'infra/dev/postgres/00-owners.sh'));

function resolvesToSharedPostgresBootstrap(path: string): boolean {
  try {
    return realpathSync(path) === sharedPostgresBootstrapPath;
  } catch {
    return false;
  }
}

const ownKeys = (value: Record<string, unknown>, expected: readonly string[], label: string) => {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} fields are not allowlisted`);
  }
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be plain data`);
  }
  return value as Record<string, unknown>;
}

function safeRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must be a relative path inside the recovery root`);
  }
  return value;
}

function containedPath(root: string, value: unknown, label: string): string {
  const path = safeRelativePath(value, label);
  const resolved = resolve(root, path);
  const back = relative(root, resolved);
  if (
    back === '' ||
    back === '..' ||
    back.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(back)
  ) {
    throw new Error(`${label} escapes the recovery root`);
  }
  return resolved;
}

function realContainedPath(root: string, path: string, label: string): string {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`);
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const back = relative(realRoot, realPath);
  if (
    back === '' ||
    back === '..' ||
    back.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(back)
  ) {
    throw new Error(`${label} resolves outside the recovery root`);
  }
  return realPath;
}

function requireFile(root: string, value: unknown, label: string): string {
  const path = containedPath(root, value, label);
  const realPath = realContainedPath(root, path, label);
  if (!lstatSync(realPath).isFile()) throw new Error(`${label} must be a regular file`);
  return realPath;
}

function requireDirectory(root: string, value: unknown, label: string): string {
  const path = containedPath(root, value, label);
  const realPath = realContainedPath(root, path, label);
  if (!lstatSync(realPath).isDirectory()) throw new Error(`${label} must be a directory`);
  return realPath;
}

function countRegularFilesWithoutLinks(directory: string, label: string): number {
  let files = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic links`);
    if (stats.isDirectory()) files += countRegularFilesWithoutLinks(path, label);
    else if (stats.isFile()) files += 1;
    else throw new Error(`${label} can contain only regular files and directories`);
  }
  return files;
}

export type CurrentRelayTransfer = Readonly<{
  format: 'rezics-current-relay-transfer-v1';
  relayDump: string;
}>;

export type IndependentRestoreExpectations = Readonly<{
  format: 'rezics-independent-restore-expectations-v1';
  samples: readonly Readonly<{ name: string; id: string }>[];
  values: readonly Readonly<{ name: string; value: string }>[];
  originalReceiptTuples: readonly (readonly [string, string, string])[];
}>;

export type IndependentRestoreTransfer = Readonly<{
  format: 'rezics-independent-restore-inputs-v1';
  root: string;
  inputs: Readonly<{
    recoverySet: string;
    currentFrontier: string;
    currentRelayDump: string;
    recipientPrivateKeyCustody: string;
    recoveryHmacKey: string;
    retainedNativeSigningMaterial: string;
  }>;
  expectations: string;
}>;

export type ResolvedIndependentRestoreInputs = Readonly<{
  root: string;
  recoverySet: string;
  currentFrontier: string;
  currentRelayDump: string;
  recipientPrivateKeyCustody: string;
  recoveryHmacKey: string;
  retainedNativeSigningMaterial: string;
  expectations: string;
}>;

export type ImportedCurrentRelay = Readonly<{
  relayPool: Pool;
  identity: Readonly<{
    host: '127.0.0.1';
    port: number;
    user: string;
    database: 'relay';
    clusterDirectory: string;
  }>;
  close: () => Promise<void>;
}>;

export type IsolationMount = Readonly<{
  type: string;
  name?: string;
  source: string;
  destination: string;
}>;

export type IsolationPublishedPort = Readonly<{
  containerPort: string;
  hostIp: string;
  hostPort: string;
}>;

export type IsolationContainer = Readonly<{
  id: string;
  name: string;
  state: string;
  project: string;
  service: string;
  mounts: readonly IsolationMount[];
  networkIds: readonly string[];
  networkAliases: readonly string[];
  links: readonly string[];
  publishedPorts: readonly IsolationPublishedPort[];
  environment: readonly string[];
  command: readonly string[];
  labels: Readonly<Record<string, string>>;
}>;

export type IsolationNetwork = Readonly<{
  id: string;
  name: string;
  containerIds: readonly string[];
}>;

export type IndependentRestoreSourceInventory = Readonly<{
  project: string;
  containers: readonly Pick<IsolationContainer, 'id' | 'name' | 'state'>[];
  volumes: readonly string[];
  volumeMounts: readonly Readonly<{
    service: string;
    name: string;
    source: string;
    destination: string;
  }>[];
  networks: readonly Pick<IsolationNetwork, 'id' | 'name'>[];
  publishedPorts: readonly Readonly<{
    containerId: string;
    containerName: string;
    containerPort: string;
    hostIp: string;
    hostPort: string;
  }>[];
  stackDirectory: string;
  objectDirectory: string;
  bindMounts: readonly Readonly<{ source: string; destination: string }>[];
}>;

export interface IsolationInspector {
  projectContainers(project: string): readonly IsolationContainer[];
  /** Docker label lookup; source ownership comes from the recorded container mounts. */
  projectLabeledVolumes(project: string): readonly string[];
  projectNetworks(project: string): readonly IsolationNetwork[];
  volumeSource(name: string): string;
  containerPresent(idOrName: string): boolean;
  volumePresent(name: string): boolean;
  networkPresent(idOrName: string): boolean;
}

export interface IndependentRestoreStackOwner {
  compose(args: string[]): unknown;
}

function exactUnique(values: readonly string[], label: string): string[] {
  const result = [...new Set(values)].sort();
  if (result.length !== values.length || result.some((value) => value.length === 0)) {
    throw new Error(`${label} inventory is incomplete or duplicated`);
  }
  return result;
}

function pathContains(parent: string, candidate: string): boolean {
  const back = relative(resolve(parent), resolve(candidate));
  return back === '' ||
    (back !== '..' && !back.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(back));
}

/** Fixture-restored source volumes may lack labels; container mounts retain their exact identities. */
function sourceVolumeMounts(project: string, containers: readonly IsolationContainer[]) {
  const mounts = containers.flatMap((container) => container.mounts
    .filter((mount) => mount.type === 'volume')
    .map((mount) => ({
      service: container.service,
      name: mount.name ?? '',
      source: mount.source,
      destination: mount.destination,
    })));
  exactUnique(mounts.map((mount) => mount.name), 'Source volume mount');
  exactUnique(mounts.map((mount) => mount.source), 'Source volume backing path');
  const expected = [
    { service: 'postgres', name: `${project}_postgres_data`, destination: '/var/lib/postgresql' },
    { service: 'fuseki', name: `${project}_fuseki_data`, destination: '/fuseki/databases' },
    { service: 'rustfs', name: `${project}_rustfs_data`, destination: '/data' },
  ];
  if (
    mounts.length !== expected.length ||
    mounts.some((mount) => !isAbsolute(mount.source)) ||
    expected.some((required) => !mounts.some((mount) =>
      mount.service === required.service && mount.name === required.name && mount.destination === required.destination))
  ) {
    throw new Error('Source volume inventory is incomplete or belongs to another project');
  }
  return mounts.map((mount) => ({ ...mount, source: resolve(mount.source) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sourcePublishedPorts(containers: readonly IsolationContainer[]) {
  return containers.flatMap((container) => container.publishedPorts.map((port) => ({
    containerId: container.id,
    containerName: container.name,
    ...port,
  }))).sort((left, right) =>
    left.containerId.localeCompare(right.containerId) ||
    left.containerPort.localeCompare(right.containerPort) ||
    left.hostIp.localeCompare(right.hostIp) ||
    left.hostPort.localeCompare(right.hostPort));
}

function assertPrivateSourceDirectory(path: string, root: string, label: string): string {
  const full = resolve(path);
  const rootStats = lstatSync(root);
  const stats = lstatSync(full);
  if (
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    !pathContains(root, full) ||
    full === resolve(root)
  ) {
    throw new Error(`${label} must be a real directory under the source stack`);
  }
  const realRoot = realpathSync(root);
  const realFull = realpathSync(full);
  if (!pathContains(realRoot, realFull) || realFull === realRoot) {
    throw new Error(`${label} resolves outside the source stack`);
  }
  return realFull;
}

/** Capture the QA harness's exact source resources before its existing stack owner disposes them. */
export function recordIndependentRestoreSourceInventory(
  project: string,
  stackDirectory: string,
  objectDirectory: string,
  inspector: IsolationInspector,
): IndependentRestoreSourceInventory {
  if (!/^rezics-qa-[a-z0-9][a-z0-9-]{0,30}$/.test(project)) {
    throw new Error('Source inventory requires an isolated QA project');
  }
  const expectedDirectory = join(repositoryRoot, '.temp', 'stack', project);
  if (resolve(stackDirectory) !== resolve(expectedDirectory)) {
    throw new Error('Source inventory directory does not belong to its QA project');
  }
  const sourceDirectory = assertPrivateSourceDirectory(stackDirectory, join(repositoryRoot, '.temp', 'stack'), 'Source stack');
  const sourceObjects = assertPrivateSourceDirectory(objectDirectory, sourceDirectory, 'Source object store');
  const containers = inspector.projectContainers(project);
  if (
    containers.length === 0 ||
    containers.some((container) => container.project !== project || !container.id || !container.name || !container.state)
  ) {
    throw new Error('Source container inventory is empty or belongs to another project');
  }
  exactUnique(containers.map((container) => container.id), 'Source container ID');
  exactUnique(containers.map((container) => container.name), 'Source container name');
  for (const service of ['postgres', 'fuseki', 'rustfs']) {
    if (!containers.some((container) => container.service === service)) {
      throw new Error(`Source ${service} container is missing from the inventory`);
    }
  }
  const volumeMounts = sourceVolumeMounts(project, containers);
  const volumes = volumeMounts.map((mount) => mount.name);
  const labeledVolumes = exactUnique(inspector.projectLabeledVolumes(project), 'Labeled source volume');
  if (
    volumeMounts.some((mount) =>
      !inspector.volumePresent(mount.name) || resolve(inspector.volumeSource(mount.name)) !== mount.source) ||
    labeledVolumes.some((name) => !volumes.includes(name))
  ) {
    throw new Error('Source volume inventory is incomplete or belongs to another project');
  }
  const networks = inspector.projectNetworks(project);
  exactUnique(networks.map((network) => network.id), 'Source network ID');
  exactUnique(networks.map((network) => network.name), 'Source network name');
  if (!networks.some((network) => network.name === `${project}_default`)) {
    throw new Error('Source project network is missing from the inventory');
  }
  const bindMounts = containers.flatMap((container) => container.mounts
    .filter((mount) => mount.type === 'bind')
    .map((mount) => ({ source: resolve(mount.source), destination: mount.destination })))
    .sort((left, right) => left.source.localeCompare(right.source) || left.destination.localeCompare(right.destination));
  const publishedPorts = sourcePublishedPorts(containers);
  return {
    project,
    containers: containers.map(({ id, name, state }) => ({ id, name, state }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    volumes,
    volumeMounts,
    networks: networks.map(({ id, name }) => ({ id, name }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    publishedPorts,
    stackDirectory: sourceDirectory,
    objectDirectory: sourceObjects,
    bindMounts,
  };
}

function assertIndependentRestoreSourceInventoryCurrent(
  inventory: IndependentRestoreSourceInventory,
  inspector: IsolationInspector,
): void {
  const currentContainers = inspector.projectContainers(inventory.project);
  const containers = currentContainers
    .map(({ id, name }) => `${id}\0${name}`).sort();
  const recordedContainers = inventory.containers
    .map(({ id, name }) => `${id}\0${name}`).sort();
  const volumeMounts = sourceVolumeMounts(inventory.project, currentContainers);
  const volumes = volumeMounts.map((mount) => mount.name);
  const labeledVolumes = exactUnique(inspector.projectLabeledVolumes(inventory.project), 'Current labeled source volume');
  const networks = inspector.projectNetworks(inventory.project)
    .map(({ id, name }) => `${id}\0${name}`).sort();
  const recordedNetworks = inventory.networks.map(({ id, name }) => `${id}\0${name}`).sort();
  const publishedPorts = sourcePublishedPorts(currentContainers);
  if (
    JSON.stringify(containers) !== JSON.stringify(recordedContainers) ||
    JSON.stringify(volumes) !== JSON.stringify(inventory.volumes) ||
    JSON.stringify(volumeMounts) !== JSON.stringify(inventory.volumeMounts) ||
    JSON.stringify(publishedPorts) !== JSON.stringify(inventory.publishedPorts) ||
    labeledVolumes.some((name) => !inventory.volumes.includes(name)) ||
    inventory.volumes.some((name) => !inspector.volumePresent(name)) ||
    JSON.stringify(networks) !== JSON.stringify(recordedNetworks) ||
    !existsSync(inventory.stackDirectory) ||
    !existsSync(inventory.objectDirectory)
  ) {
    throw new Error('Source inventory changed before disposal');
  }
}

function assertIndependentRestoreSourceDockerAbsent(
  inventory: IndependentRestoreSourceInventory,
  inspector: IsolationInspector,
): void {
  for (const container of inventory.containers) {
    if (inspector.containerPresent(container.id) || inspector.containerPresent(container.name)) {
      throw new Error(`Recorded source container remains: ${container.name}`);
    }
  }
  for (const volume of inventory.volumes) {
    if (inspector.volumePresent(volume)) throw new Error(`Recorded source volume remains: ${volume}`);
  }
  for (const network of inventory.networks) {
    if (inspector.networkPresent(network.id) || inspector.networkPresent(network.name)) {
      throw new Error(`Recorded source network remains: ${network.name}`);
    }
  }
  if (
    inspector.projectContainers(inventory.project).length > 0 ||
    inspector.projectLabeledVolumes(inventory.project).length > 0 ||
    inspector.projectNetworks(inventory.project).length > 0
  ) {
    throw new Error('Unrecorded source project resources remain');
  }
}

/** Fail while any recorded source identity or source-local path still exists. */
export function assertIndependentRestoreSourceAbsent(
  inventory: IndependentRestoreSourceInventory,
  inspector: IsolationInspector,
): void {
  assertIndependentRestoreSourceDockerAbsent(inventory, inspector);
  for (const path of [inventory.objectDirectory, inventory.stackDirectory]) {
    if (existsSync(path)) throw new Error(`Recorded source directory remains: ${path}`);
  }
}

/** Use the source stack's Compose owner, then require complete removal before target creation. */
export function disposeIndependentRestoreSource(
  inventory: IndependentRestoreSourceInventory,
  owner: IndependentRestoreStackOwner,
  inspector: IsolationInspector,
): void {
  assertIndependentRestoreSourceInventoryCurrent(inventory, inspector);
  owner.compose(['down', '--volumes', '--remove-orphans']);
  assertIndependentRestoreSourceDockerAbsent(inventory, inspector);
  for (const path of [inventory.objectDirectory, inventory.stackDirectory]) {
    if (existsSync(path)) rmSync(path, { recursive: true });
  }
  assertIndependentRestoreSourceAbsent(inventory, inspector);
}

function isolationDockerOutput(args: string[], environment: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('docker', args, {
      cwd: repositoryRoot,
      env: preserveReapEnvironment(environment),
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new Error(`Docker isolation inspection failed (${args[0] ?? 'command'})`, { cause: error });
  }
}

/** Read only Compose project identities needed by the independent restore isolation proof. */
export function createIsolationInspector(environment: NodeJS.ProcessEnv = process.env): IsolationInspector {
  const inspectContainer = (id: string): IsolationContainer => {
    const raw = JSON.parse(isolationDockerOutput(['inspect', id], environment))[0] as {
      Id: string;
      Name: string;
      State: { Status: string };
      Config: {
        Labels?: Record<string, string> | null;
        Env?: string[] | null;
        Entrypoint?: string[] | null;
        Cmd?: string[] | null;
      };
      HostConfig?: {
        Links?: string[] | null;
        PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
      } | null;
      Mounts: { Type: string; Name?: string; Source: string; Destination: string }[];
      NetworkSettings: {
        Networks?: Record<string, {
          NetworkID: string;
          Aliases?: string[] | null;
          Links?: string[] | null;
        }> | null;
      };
    } | undefined;
    if (!raw) throw new Error('Docker returned no container identity');
    const labels = raw.Config.Labels ?? {};
    const networks = Object.values(raw.NetworkSettings.Networks ?? {});
    return {
      id: raw.Id,
      name: raw.Name.startsWith('/') ? raw.Name.slice(1) : raw.Name,
      state: raw.State.Status,
      project: labels['com.docker.compose.project'] ?? '',
      service: labels['com.docker.compose.service'] ?? '',
      mounts: raw.Mounts.map((mount) => ({
        type: mount.Type,
        ...(mount.Name ? { name: mount.Name } : {}),
        source: mount.Source,
        destination: mount.Destination,
      })),
      networkIds: networks.map((network) => network.NetworkID),
      networkAliases: networks.flatMap((network) => network.Aliases ?? []),
      links: [...(raw.HostConfig?.Links ?? []), ...networks.flatMap((network) => network.Links ?? [])],
      publishedPorts: Object.entries(raw.HostConfig?.PortBindings ?? {}).flatMap(([containerPort, bindings]) =>
        (bindings ?? []).map((binding) => ({
          containerPort,
          hostIp: binding.HostIp ?? '',
          hostPort: binding.HostPort ?? '',
        }))),
      environment: raw.Config.Env ?? [],
      command: [...(raw.Config.Entrypoint ?? []), ...(raw.Config.Cmd ?? [])],
      labels,
    };
  };
  const projectContainers = (project: string) => {
    const ids = isolationDockerOutput([
      'ps', '--all', '--quiet', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
    ], environment).split(/\r?\n/).filter(Boolean);
    return ids.map(inspectContainer);
  };
  const projectLabeledVolumes = (project: string) => isolationDockerOutput([
    'volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`,
  ], environment).split(/\r?\n/).filter(Boolean);
  const projectNetworks = (project: string): IsolationNetwork[] => {
    const ids = isolationDockerOutput([
      'network', 'ls', '--quiet', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
    ], environment).split(/\r?\n/).filter(Boolean);
    if (ids.length === 0) return [];
    const raw = JSON.parse(isolationDockerOutput(['network', 'inspect', ...ids], environment)) as {
      Id: string;
      Name: string;
      Containers?: Record<string, unknown> | null;
    }[];
    return raw.map((network) => ({
      id: network.Id,
      name: network.Name,
      containerIds: Object.keys(network.Containers ?? {}),
    }));
  };
  const containerPresent = (idOrName: string) => {
    const filter = /^[0-9a-f]{12,64}$/.test(idOrName)
      ? `id=${idOrName}`
      : `name=^/${idOrName}$`;
    return isolationDockerOutput(['ps', '--all', '--quiet', '--no-trunc', '--filter', filter], environment) !== '';
  };
  const volumePresent = (name: string) => isolationDockerOutput([
    'volume', 'ls', '--format', '{{.Name}}', '--filter', `name=${name}`,
  ], environment).split(/\r?\n/).some((candidate) => candidate === name);
  const volumeSource = (name: string) => {
    const raw = JSON.parse(isolationDockerOutput(['volume', 'inspect', name], environment))[0] as {
      Name: string;
      Mountpoint: string;
    } | undefined;
    if (!raw || raw.Name !== name || !raw.Mountpoint || !isAbsolute(raw.Mountpoint)) {
      throw new Error('Docker returned no volume backing path');
    }
    return raw.Mountpoint;
  };
  const networkPresent = (idOrName: string) => {
    const filter = /^[0-9a-f]{12,64}$/.test(idOrName)
      ? `id=${idOrName}`
      : `name=${idOrName}`;
    return isolationDockerOutput(['network', 'ls', '--no-trunc', '--format', '{{.ID}}\t{{.Name}}', '--filter', filter], environment)
      .split(/\r?\n/).some((line) => line.split('\t').some((candidate) => candidate === idOrName));
  };
  return { projectContainers, projectLabeledVolumes, projectNetworks, volumeSource, containerPresent, volumePresent, networkPresent };
}

function withTargetIdentityRefusal(work: () => void): void {
  try {
    work();
  } catch (error) {
    if (error instanceof RecoveryRefusal) throw error;
    const message = error instanceof Error ? error.message : 'Target identity inspection failed';
    throw new RecoveryRefusal('target-identity-refused', message, { cause: error });
  }
}

function hasExactSet(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual);
  return actualSet.size === actual.length &&
    actualSet.size === expected.length &&
    expected.every((value) => actualSet.has(value));
}

function sourceIdentityFragments(source: IndependentRestoreSourceInventory): string[] {
  const containerIds = source.containers.flatMap(({ id }) =>
    /^[0-9a-f]{12,64}$/.test(id) ? [id.slice(0, 12), id] : [id]);
  return [...new Set([
    ...source.containers.flatMap(({ name }) => [name]),
    ...containerIds,
    ...source.volumes,
    ...source.volumeMounts.flatMap((mount) => [mount.name, resolve(mount.source)]),
    ...source.networks.flatMap((network) => [network.id, network.name]),
  ].filter(Boolean))];
}

function namesExactSourceProject(container: IsolationContainer, sourceProject: string): boolean {
  const values = [
    ...container.environment,
    ...container.command,
    ...Object.entries(container.labels)
      .filter(([key]) => key !== 'com.docker.compose.project')
      .map(([, value]) => value),
  ].map((value) => {
    const separator = value.indexOf('=');
    return separator === -1 ? value : value.slice(separator + 1);
  });
  return values.some((value) => value === sourceProject);
}

function sourceContainerFragments(source: IndependentRestoreSourceInventory): string[] {
  return [...new Set(source.containers.flatMap(({ id, name }) => [
    name,
    ...( /^[0-9a-f]{12,64}$/.test(id) ? [id.slice(0, 12), id] : [id]),
  ]))];
}

function hostAddressesConflict(left: string, right: string): boolean {
  const wildcardAddresses = new Set(['', '0.0.0.0', '::']);
  return left === right || wildcardAddresses.has(left) || wildcardAddresses.has(right);
}

/** Assert that the target storage containers use only fresh storage and the exact target network. */
export function assertIndependentRestoreTargetIdentity(
  targetProject: string,
  source: IndependentRestoreSourceInventory,
  containers: readonly IsolationContainer[],
  networks: readonly IsolationNetwork[],
  inspector: IsolationInspector,
): void {
  withTargetIdentityRefusal(() => {
    if (!/^rezics-qa-[a-z0-9][a-z0-9-]{0,30}$/.test(targetProject)) {
      throw new RecoveryRefusal(
        'invalid-target-project',
        'Target inspection requires an isolated QA project distinct from the source',
      );
    }
    if (targetProject === source.project) {
      throw new RecoveryRefusal(
        'original-project',
        'Target inspection requires an isolated QA project distinct from the source',
      );
    }
    if (source.containers.some((container) =>
      inspector.containerPresent(container.id) || inspector.containerPresent(container.name)) ||
      inspector.projectContainers(source.project).length > 0
    ) {
      throw new Error('A recorded source container remains after source disposal');
    }
    const services = new Map(containers.map((container) => [container.service, container]));
    if (
      containers.length !== 3 ||
      services.size !== 3 ||
      containers.some((container) =>
        container.project !== targetProject ||
        container.labels['com.docker.compose.project'] !== targetProject ||
        container.labels['com.docker.compose.project'] === source.project) ||
      ['postgres', 'fuseki', 'rustfs'].some((service) => !services.has(service))
    ) {
      throw new Error('Target storage container inventory is incomplete or mixed with another project');
    }
    const targetContainers = [...services.values()];
    const targetContainerIds = exactUnique(targetContainers.map((container) => container.id), 'Target container ID');
    exactUnique(targetContainers.map((container) => container.name), 'Target container name');
    const sourceVolumes = new Set(source.volumes);
    const sourceVolumePaths = new Set(source.volumeMounts.map((mount) => resolve(mount.source)));
    const sourceReferences = sourceIdentityFragments(source);
    const sourceContainerReferences = sourceContainerFragments(source);
    const sourceHostPorts = source.publishedPorts;
    for (const [service, kind, destination] of [
      ['postgres', 'postgres_data', '/var/lib/postgresql'],
      ['fuseki', 'fuseki_data', '/fuseki/databases'],
      ['rustfs', 'rustfs_data', '/data'],
    ] as const) {
      const container = services.get(service)!;
      const expectedName = `${targetProject}_${kind}`;
      const expectedSourceValue = inspector.volumeSource(expectedName);
      if (!isAbsolute(expectedSourceValue)) {
        throw new Error(`Target ${service} expected volume backing path is invalid`);
      }
      const expectedSource = resolve(expectedSourceValue);
      if (sourceVolumePaths.has(expectedSource)) {
        throw new RecoveryRefusal(
          'source-volume-alias',
          `Target ${service} expected volume reuses a recorded source volume backing path`,
        );
      }
      let expectedVolumeMounts = 0;
      let expectedBootstrapMounts = 0;
      for (const mount of container.mounts) {
        const sourcePath = mount.source ? resolve(mount.source) : '';
        if (mount.type === 'volume' && mount.name && sourceVolumes.has(mount.name)) {
          throw new RecoveryRefusal(
            'source-volume-alias',
            `Target ${service} aliases recorded source volume ${mount.name}`,
          );
        }
        if (sourcePath && sourceVolumePaths.has(sourcePath)) {
          const sourceMount = source.volumeMounts.find((candidate) => resolve(candidate.source) === sourcePath);
          throw new RecoveryRefusal(
            'source-volume-alias',
            `Target ${service} aliases recorded source volume backing path ${sourceMount?.name ?? sourcePath}`,
          );
        }
        if (mount.type === 'volume') {
          if (
            mount.name !== expectedName ||
            mount.destination !== destination ||
            resolve(mount.source) !== expectedSource
          ) {
            throw new Error(`Target ${service} has an unapproved volume mount`);
          }
          expectedVolumeMounts++;
          continue;
        }
        if (mount.type === 'bind') {
          if (pathContains(source.stackDirectory, mount.source)) {
            throw new RecoveryRefusal('source-bind-alias', `Target ${service} aliases a source bind path`);
          }
          const aliasesRecordedBind = source.bindMounts.some((sourceBind) =>
            resolve(sourceBind.source) === sourcePath);
          const isSharedBootstrapBind = service === 'postgres' &&
            mount.destination === '/docker-entrypoint-initdb.d/00-owners.sh' &&
            resolvesToSharedPostgresBootstrap(mount.source) &&
            source.bindMounts.some((sourceBind) =>
              sourceBind.destination === mount.destination &&
              resolvesToSharedPostgresBootstrap(sourceBind.source));
          if (aliasesRecordedBind && !isSharedBootstrapBind) {
            throw new RecoveryRefusal('source-bind-alias', `Target ${service} aliases a source bind path`);
          }
          if (!isSharedBootstrapBind) {
            throw new Error(`Target ${service} has an unapproved bind mount`);
          }
          expectedBootstrapMounts++;
          continue;
        }
        throw new Error(`Target ${service} has an unapproved ${mount.type} mount`);
      }
      if (expectedVolumeMounts !== 1 || (service === 'postgres' ? expectedBootstrapMounts !== 1 : expectedBootstrapMounts !== 0)) {
        throw new Error(`Target ${service} does not mount its expected new volume`);
      }
      if (!hasExactSet(container.networkIds, [networks.find((network) => network.name === `${targetProject}_default`)?.id ?? ''])) {
        throw new Error(`Target ${service} has an unapproved network set`);
      }
      const sourceAliases = [...container.networkAliases, ...container.links];
      if (sourceAliases.some((value) => sourceContainerReferences.some((reference) => value.includes(reference)))) {
        throw new Error(`Target ${service} aliases or links to a recorded source container`);
      }
      if ([...container.environment, ...container.command, ...Object.entries(container.labels)
        .filter(([key]) => key !== 'com.docker.compose.project')
        .flatMap(([key, value]) => [key, value])]
        .some((value) => sourceReferences.some((reference) => value.includes(reference))) ||
        namesExactSourceProject(container, source.project)) {
        throw new Error(`Target ${service} metadata names a recorded source identity`);
      }
      for (const port of container.publishedPorts) {
        if (!port.containerPort || !port.hostPort) {
          throw new Error(`Target ${service} has an unresolved published host port`);
        }
        if (sourceHostPorts.some((sourcePort) =>
          sourcePort.hostPort === port.hostPort && hostAddressesConflict(sourcePort.hostIp, port.hostIp))) {
          throw new Error(`Target ${service} reuses a published source host port`);
        }
      }
    }
    const defaultNetworks = networks.filter((network) => network.name === `${targetProject}_default`);
    if (
      networks.length !== 1 ||
      defaultNetworks.length !== 1 ||
      networks[0]?.id !== defaultNetworks[0]?.id
    ) {
      throw new Error('Target project network inventory contains an unapproved network');
    }
    const network = defaultNetworks[0]!;
    if (source.networks.some((sourceNetwork) =>
      sourceNetwork.id === network.id || sourceNetwork.name === network.name)) {
      throw new Error('Target project reuses a recorded source network');
    }
    if (!hasExactSet(network.containerIds, targetContainerIds)) {
      throw new Error('Target project network peer set differs from its storage containers');
    }
  });
}

/** Inspect the three storage containers and one local Compose network after restore. */
export function inspectIndependentRestoreTarget(
  targetProject: string,
  source: IndependentRestoreSourceInventory,
  inspector: IsolationInspector,
): void {
  withTargetIdentityRefusal(() => {
    if (!/^rezics-qa-[a-z0-9][a-z0-9-]{0,30}$/.test(targetProject)) {
      throw new RecoveryRefusal('invalid-target-project', 'Target inspection requires an isolated QA project');
    }
    const containers = inspector.projectContainers(targetProject);
    const networks = inspector.projectNetworks(targetProject);
    assertIndependentRestoreTargetIdentity(targetProject, source, containers, networks, inspector);
  });
}

function parseExpectations(value: unknown): IndependentRestoreExpectations {
  const data = record(value, 'Expectations');
  ownKeys(data, ['format', 'samples', 'values', 'originalReceiptTuples'], 'Expectations');
  if (data.format !== 'rezics-independent-restore-expectations-v1') {
    throw new Error('Expectations format is invalid');
  }
  const samples = data.samples;
  const values = data.values;
  const receipts = data.originalReceiptTuples;
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > 64) {
    throw new Error('Expectations samples are invalid');
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > 128) {
    throw new Error('Expectations values are invalid');
  }
  if (!Array.isArray(receipts) || receipts.length === 0 || receipts.length > 256) {
    throw new Error('Expectations receipt tuples are invalid');
  }
  const validateNamedString = (entry: unknown, label: string, key: 'id' | 'value') => {
    const item = record(entry, label);
    ownKeys(item, ['name', key], label);
    if (
      typeof item.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.name) ||
      /authority|connection[-_]?string|database[-_]?url|environment|password|secret|token|source[-_]?config/i.test(
        item.name,
      ) ||
      typeof item[key] !== 'string' ||
      item[key].length === 0 ||
      item[key].length > (key === 'id' ? 256 : 4096)
    ) {
      throw new Error(`${label} must contain bounded named strings`);
    }
  };
  for (const sample of samples) validateNamedString(sample, 'Expectation sample', 'id');
  for (const item of values) validateNamedString(item, 'Expectation value', 'value');
  for (const tuple of receipts) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      tuple.some((field) => typeof field !== 'string' || field.length === 0 || field.length > 512)
    ) {
      throw new Error('Expectation receipt tuples must contain three bounded strings');
    }
  }
  return value as IndependentRestoreExpectations;
}

/** Build a relative, JSON-safe handle to a retained relay dump under `.temp`. */
export function currentRelayTransferForDump(dumpFile: string): CurrentRelayTransfer {
  const full = resolve(dumpFile);
  const relativePath = relative(repositoryRoot, full).split(process.platform === 'win32' ? '\\' : '/').join('/');
  if (
    relativePath === '' ||
    relativePath.startsWith('../') ||
    isAbsolute(relativePath) ||
    !relativePath.startsWith('.temp/') ||
    !relativePath.endsWith('/relay.dump')
  ) {
    throw new Error('Current relay dump must be retained as `.temp/**/relay.dump`');
  }
  return { format: 'rezics-current-relay-transfer-v1', relayDump: relativePath };
}

export function assertCurrentRelayTransfer(value: unknown): CurrentRelayTransfer {
  const transfer = record(value, 'Current relay transfer');
  ownKeys(transfer, ['format', 'relayDump'], 'Current relay transfer');
  if (transfer.format !== 'rezics-current-relay-transfer-v1') {
    throw new Error('Current relay transfer format is invalid');
  }
  const relayDump = safeRelativePath(transfer.relayDump, 'Current relay dump');
  if (!relayDump.startsWith('.temp/') || !relayDump.endsWith('/relay.dump')) {
    throw new Error('Current relay dump must be retained as `.temp/**/relay.dump`');
  }
  return { format: 'rezics-current-relay-transfer-v1', relayDump };
}

/** Parse the data-only bundle that a fresh restore child may receive. */
export function assertIndependentRestoreTransfer(value: unknown): IndependentRestoreTransfer {
  const transfer = record(value, 'Independent restore transfer');
  ownKeys(transfer, ['format', 'root', 'inputs', 'expectations'], 'Independent restore transfer');
  if (transfer.format !== 'rezics-independent-restore-inputs-v1') {
    throw new Error('Independent restore transfer format is invalid');
  }
  const root = safeRelativePath(transfer.root, 'Recovery root');
  if (!root.startsWith('.temp/')) throw new Error('Recovery root must be inside `.temp`');
  const inputs = record(transfer.inputs, 'Independent restore inputs');
  ownKeys(
    inputs,
    [
      'recoverySet',
      'currentFrontier',
      'currentRelayDump',
      'recipientPrivateKeyCustody',
      'recoveryHmacKey',
      'retainedNativeSigningMaterial',
    ],
    'Independent restore inputs',
  );
  for (const [name, path] of Object.entries(inputs)) safeRelativePath(path, `Input ${name}`);
  const expectations = safeRelativePath(transfer.expectations, 'Expectations');
  return {
    format: 'rezics-independent-restore-inputs-v1',
    root,
    inputs: inputs as IndependentRestoreTransfer['inputs'],
    expectations,
  };
}

export function serializeIndependentRestoreTransfer(value: unknown): string {
  return JSON.stringify(assertIndependentRestoreTransfer(value));
}

/** Resolve only the explicitly transferred inputs and reject links or missing files. */
export function resolveIndependentRestoreInputs(value: unknown): ResolvedIndependentRestoreInputs {
  const transfer = assertIndependentRestoreTransfer(value);
  const rootCandidate = resolve(repositoryRoot, transfer.root);
  const worktreeRelative = relative(repositoryRoot, rootCandidate);
  if (
    worktreeRelative === '' ||
    worktreeRelative === '..' ||
    worktreeRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(worktreeRelative)
  ) {
    throw new Error('Recovery root escapes the worktree');
  }
  const tempRoot = realpathSync(join(repositoryRoot, '.temp'));
  const root = realContainedPath(tempRoot, rootCandidate, 'Recovery root');
  const recoverySet = requireDirectory(root, transfer.inputs.recoverySet, 'Recovery set');
  const recoveryFiles = [...artifactNames, 'set.json'].sort();
  const actualRecoveryFiles = readdirSync(recoverySet).sort();
  if (
    actualRecoveryFiles.length !== recoveryFiles.length ||
    actualRecoveryFiles.some((name, index) => name !== recoveryFiles[index])
  ) {
    throw new Error('Recovery set does not contain the exact allowlisted artifacts');
  }
  for (const name of recoveryFiles) requireFile(recoverySet, name, `Recovery artifact ${name}`);
  const currentFrontier = requireFile(root, transfer.inputs.currentFrontier, 'Current frontier');
  const currentRelayDump = requireFile(root, transfer.inputs.currentRelayDump, 'Current relay dump');
  const recipientPrivateKeyCustody = requireDirectory(
    root,
    transfer.inputs.recipientPrivateKeyCustody,
    'Recipient private key custody',
  );
  if (countRegularFilesWithoutLinks(recipientPrivateKeyCustody, 'Recipient private key custody') === 0) {
    throw new Error('Recipient private key custody has no regular files');
  }
  const recoveryHmacKey = requireFile(root, transfer.inputs.recoveryHmacKey, 'Recovery HMAC key');
  if (lstatSync(recoveryHmacKey).size === 0) throw new Error('Recovery HMAC key is empty');
  const retainedNativeSigningMaterial = requireFile(
    root,
    transfer.inputs.retainedNativeSigningMaterial,
    'Retained native signing material',
  );
  if (lstatSync(retainedNativeSigningMaterial).size === 0) {
    throw new Error('Retained native signing material is empty');
  }
  const expectations = requireFile(root, transfer.expectations, 'Expectations');
  const expectationSize = lstatSync(expectations).size;
  if (expectationSize === 0 || expectationSize > 256 * 1024) {
    throw new Error('Expectations file must be non-empty and bounded');
  }
  parseExpectations(JSON.parse(readFileSync(expectations, 'utf8')) as unknown);
  return {
    root,
    recoverySet,
    currentFrontier,
    currentRelayDump,
    recipientPrivateKeyCustody,
    recoveryHmacKey,
    retainedNativeSigningMaterial,
    expectations,
  };
}

const inheritedEnvironmentAllowlist = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const;

/** Construct the restore child's environment without inheriting source credentials or paths. */
export function createIndependentRestoreChildEnvironment(
  environment: NodeJS.ProcessEnv,
  inputs: ResolvedIndependentRestoreInputs,
): NodeJS.ProcessEnv {
  const path = environment.PATH;
  if (!path || path.includes('\0')) throw new Error('Child environment requires a safe PATH');
  const home = join(inputs.root, 'child-home');
  const temp = join(inputs.root, 'child-tmp');
  for (const directory of [home, temp]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  realContainedPath(inputs.root, home, 'Child home');
  realContainedPath(inputs.root, temp, 'Child temporary directory');
  const child: NodeJS.ProcessEnv = {
    PATH: path,
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    GNUPGHOME: inputs.recipientPrivateKeyCustody,
  };
  for (const name of inheritedEnvironmentAllowlist.slice(1)) {
    const value = environment[name];
    if (value === undefined) continue;
    if (value.includes('\0') || value.length > 256) throw new Error(`Child environment ${name} is invalid`);
    child[name] = value;
  }
  return child;
}

/** Import a copied dump using a new, local, trust-authenticated QA cluster. */
export async function importCurrentRelay(value: unknown): Promise<ImportedCurrentRelay> {
  const transfer = assertCurrentRelayTransfer(value);
  const dump = resolve(repositoryRoot, transfer.relayDump);
  const tempRoot = realpathSync(join(repositoryRoot, '.temp'));
  realContainedPath(tempRoot, dump, 'Current relay dump');
  if (!existsSync(dump) || !lstatSync(dump).isFile()) throw new Error('Current relay dump is unavailable');
  const cluster = await startPostgresCluster({ role: 'postgres' });
  const url = `postgresql://postgres@127.0.0.1:${cluster.port}/relay`;
  try {
    execFileSync(
      'createdb',
      ['-h', '127.0.0.1', '-p', String(cluster.port), '-U', 'postgres', 'relay'],
      { timeout: 30_000 },
    );
    execFileSync(
      'pg_restore',
      ['--exit-on-error', '--no-owner', '--no-privileges', `--dbname=${url}`, dump],
      { timeout: 60_000 },
    );
    const relayPool = new Pool({ connectionString: url, max: 4 });
    relayPool.on('error', () => {});
    return {
      relayPool,
      identity: {
        host: '127.0.0.1',
        port: cluster.port,
        user: 'postgres',
        database: 'relay',
        clusterDirectory: cluster.directory,
      },
      close: async () => {
        await relayPool.end();
        cluster.remove();
      },
    };
  } catch (error) {
    cluster.remove();
    throw error;
  }
}
