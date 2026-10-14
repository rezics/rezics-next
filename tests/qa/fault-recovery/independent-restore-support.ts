import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  appendFileSync,
  cpSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { Pool } from 'pg';
import { artifactNames, RecoveryRefusal } from '../../../scripts/ops/recovery-set.ts';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { startPostgresCluster, startPreparedPostgresCluster } from '../support/postgres-cluster.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { OwnerOperations, readNativeAccessAttachment } from '../../../services/main/src/modules/owner/operations.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { DATASET, GRAPHS, RV, initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { ensureModelGeneration } from '../../../services/main/src/modules/semantic/command.ts';
import type { AccessErasureRecoverySummary } from '../../../services/main/src/modules/access/erasure-recovery.ts';
import { captureGraphRecoveryCoverage, type RecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { retainErasureCoverage } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { heldErasureMaintenanceClient, readGraphErasureProof } from '../../../services/main/src/modules/erasure/graph.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { migrateFixtureOwners } from '../../../scripts/fixture/migrate.ts';
import { backupRecoverySet, objectStore } from '../../../scripts/ops/backup.ts';
import { administratorUrl, assertRegularTree, assertSafeTar, encryptRecoveryAttachment, fileDigest, openIndex, RecoveryBudget, seal, stackContext, type EncryptedRecoveryAttachment } from '../../../scripts/ops/recovery-set.ts';
import { restoreRecoverySet, type RestoredContext, type RestoreChecks } from '../../../scripts/ops/restore.ts';
import { openRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { commandAsync } from '../../../scripts/qa/core.ts';
import { runQaStartupChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { seedRecoveryContent } from './search-content-fixture.ts';
import { createRecipeApiRequest, readMembershipCompletionProof, seedRecipeBeforeCut, type RecipeSeed } from './operator-restore-recipe-support.ts';
import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';
import { ReceiptCustody, PostgresReceiptCustodyStore } from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { normalizeStoredMembership } from '../../../services/main/src/modules/structure/membership-normalize.ts';
import { readManifest } from '../../../scripts/fixture/build.ts';
import { compatibleFixture, type FixtureRestoreEvidence } from '../../../scripts/fixture/restore.ts';

import { RetainedSources, RetainedSourceRefusal, sourceKey, sourceFileDigests,
  type RetainedSourceAdapter, type SourceContext } from '../../../scripts/qa/retained-source.ts';
import { migrationInventory, type RetainedOwnerState } from '../../../scripts/fixture/manifest.ts';
import { sha256, stable } from '../../../scripts/fixture/corpus.ts';
import { fixtureModel } from '../../../scripts/fixture/model.ts';
import { currentEngines, dockerEnvironment } from '../../../scripts/fixture/stack.ts';
import { producerModules } from './owner-restore-erasure-fixture.ts';
import { runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');

/** Cleanup must not replace the failure that made the restore fail. */
export async function preserveRestoreCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  let primary: { error: unknown } | undefined;
  try {
    return await operation();
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    try { await cleanup(); }
    catch (error) {
      if (primary) throw new AggregateError([primary.error, error],
        'Restore failed and cleanup also failed', { cause: primary.error });
      throw error;
    }
  }
}

export function findRecoveryRefusal(error: unknown): RecoveryRefusal | undefined {
  const seen = new Set<object>();
  while (error !== null && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    if (error instanceof RecoveryRefusal) return error;
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}

interface RestoreFailureRecord {
  name: string;
  message: string;
  code?: string;
  status?: number;
  cause?: RestoreFailureRecord;
  errors?: RestoreFailureRecord[];
}

function restoreFailureRecord(error: unknown, seen = new Set<object>()): RestoreFailureRecord {
  if (error === null || typeof error !== 'object') return { name: 'Error', message: String(error) };
  if (seen.has(error)) return { name: 'Error', message: 'Circular failure reference' };
  seen.add(error);
  const failure = error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; cause?: unknown };
  return {
    name: typeof failure.name === 'string' ? failure.name : 'Error',
    message: typeof failure.message === 'string' ? failure.message : String(error),
    ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
    ...(typeof failure.status === 'number' ? { status: failure.status } : {}),
    ...(failure.cause === undefined ? {} : { cause: restoreFailureRecord(failure.cause, new Set(seen)) }),
    ...(error instanceof AggregateError ? { errors: error.errors.map(item => restoreFailureRecord(item, new Set(seen))) } : {}),
  };
}

function rebuildRestoreFailure(record: RestoreFailureRecord): Error {
  const options = record.cause ? { cause: rebuildRestoreFailure(record.cause) } : undefined;
  const error = record.errors
    ? new AggregateError(record.errors.map(rebuildRestoreFailure), record.message, options)
    : record.name === 'RecoveryRefusal' && record.code !== undefined
      ? new RecoveryRefusal(record.code as RecoveryRefusal['code'], record.message, options)
      : new Error(record.message, options);
  error.name = record.name;
  if (record.code !== undefined) Object.assign(error, { code: record.code });
  if (record.status !== undefined) Object.assign(error, { status: record.status });
  return error;
}

/** The child records every thrown path, including input and cleanup failures. */
export async function recordIndependentRestoreChildFailure(
  failureFile: string,
  operation: () => Promise<void>,
): Promise<void> {
  try { await operation(); }
  catch (error) {
    await preserveRestoreCleanup(async () => { throw error; }, () => {
      writeDrillJson(failureFile, restoreFailureRecord(error));
    });
  }
}

export function readIndependentRestoreChildFailure(failureFile: string): Error {
  return rebuildRestoreFailure(JSON.parse(readFileSync(failureFile, 'utf8')) as RestoreFailureRecord);
}

function failedCommand(message: string, result: { timedOut: boolean; output: string }): Error {
  const cause = result.timedOut
    ? Object.assign(new Error('Command deadline exceeded'), { code: 'ETIMEDOUT' })
    : new Error(result.output);
  return new Error(message, { cause });
}
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
    currentAuthorityCoverage: string;
    nativeAccessAttachment: string;
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
  currentAuthorityCoverage: string;
  nativeAccessAttachment: string;
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
      'currentAuthorityCoverage',
      'nativeAccessAttachment',
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
  // C1 and D are separately retained inputs; the immutable physical set stays C0.
  const currentAuthorityCoverage = requireFile(
    root,
    transfer.inputs.currentAuthorityCoverage,
    'Current authority coverage',
  );
  const nativeAccessAttachment = requireFile(
    root,
    transfer.inputs.nativeAccessAttachment,
    'Native Access attachment',
  );
  for (const [label, path] of [
    ['Current authority coverage', currentAuthorityCoverage],
    ['Native Access attachment', nativeAccessAttachment],
  ] as const) {
    if (pathContains(recoverySet, path)) throw new Error(`${label} must be outside the recovery set`);
    if (lstatSync(path).size === 0) throw new Error(`${label} is empty`);
  }
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
    currentAuthorityCoverage,
    nativeAccessAttachment,
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
  // Orchestration identity crosses the process seam; source credentials never do.
  for (const name of ['GOAL_QA_SLOT_DIRECTORY', 'GOAL_IN_SLOT', 'REZICS_QA_STARTUP_SLOT_GATE',
    'REZICS_QA_MEMORY_DEADLINE', 'REZICS_QA_MEMORY_EVENTS', 'REZICS_QA_RUN_REMAINING_MS',
    'REZICS_QA_STACK_REGISTRY']) {
    const value = environment[name];
    if (value === undefined) continue;
    if (value.includes('\0') || value.length > 4096) throw new Error(`Child orchestration ${name} is invalid`);
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
        await preserveRestoreCleanup(() => relayPool.end(), () => cluster.remove());
      },
    };
  } catch (error) {
    return preserveRestoreCleanup(async () => { throw error; }, () => cluster.remove());
  }
}

interface PhysicalRestoreSamples {
  source: IndependentRestoreSourceInventory;
  project: string;
  work: string;
  revisionId: string;
  actingSubject: string;
  operator: { issuer: string; subject: string };
  erasureId: string;
  erasureEpoch: string;
  admissionId: string;
  original: { receipt: string; dataEpoch: string; sequence: string };
  recipe?: RecipeSeed;
}

function writeDrillJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Only IDs, expected values and original receipts cross this seam. */
function physicalRestoreSamples(path: string): PhysicalRestoreSamples {
  const expectations = parseExpectations(JSON.parse(readFileSync(path, 'utf8')));
  const encoded = expectations.values.map((item, index) => {
    assert.equal(item.name, `sample${index}`);
    return item.value;
  }).join('');
  const samples = JSON.parse(encoded) as PhysicalRestoreSamples;
  assert.deepEqual(expectations.originalReceiptTuples,
    [[samples.original.receipt, samples.original.dataEpoch, samples.original.sequence]]);
  assert.deepEqual(expectations.samples, [{ name: 'erasedRevision', id: samples.revisionId }]);
  return samples;
}

/** Observe production workers, without initializing or repairing their cursors.
 * Restore itself must leave a deployable checkpoint and complete custody. */
async function verifyRunningRestoredWorkers(context: RestoredContext, artifactDirectory: string): Promise<void> {
  const children: { name: string; child: ChildProcess; log: string; error?: Error }[] = [];
  const environment = { ...process.env, ...context.apps, NODE_ENV: 'production',
    MAIN_RELAY_INTERVAL_MS: '100', CONTENT_PROJECTION_INTERVAL_MS: '100' };
  const started = Date.now();
  await preserveRestoreCleanup(async () => {
    for (const [name, entry] of [['main', 'index.ts'], ['main-relay', 'relay.ts']] as const) {
      const log = join(artifactDirectory, `${name}-production.log`);
      const descriptor = openSync(log, 'w', 0o600);
      await preserveRestoreCleanup(async () => {
        const child = spawn('bun', [join(repositoryRoot, 'services/main/src', entry)], {
          cwd: repositoryRoot, env: environment, stdio: ['ignore', descriptor, descriptor],
        });
        const worker: typeof children[number] = { name, child, log };
        child.on('error', error => { worker.error = error; });
        children.push(worker);
      }, () => closeSync(descriptor));
    }
    const deadline = Math.min(started + 60_000, started + context.budget.remaining());
    let stable = 0;
    let observed: Record<string, unknown> = {};
    let readinessFailure: unknown;
    while (Date.now() < deadline) {
      for (const worker of children) {
        if (worker.error) throw worker.error;
        const output = readFileSync(worker.log, 'utf8');
        assert.equal(worker.child.exitCode, null, `${worker.name} exited: ${output.slice(-3000)}`);
        assert.equal(worker.child.signalCode, null, `${worker.name} was signalled`);
        // The relay retries checkpoint conflicts; being alive alone proves nothing.
        assert.doesNotMatch(output, /RelayCheckpointConflict|main_relay_(retry|failed|blocked)|custodi[^\n]*(missing|unavailable)|outbox batch header missing/iu);
        assert.doesNotMatch(output, /"event":"(?:worker_run_failed|worker_fault)"[^\n]*main\.content\.projection/u);
      }
      const relay = (await context.pools.relay.query(
        'SELECT data_epoch, sequence::text FROM relay.checkpoint WHERE consumer=$1',
        [context.apps.MAIN_RELAY_CONSUMER])).rows[0];
      const graph = await context.fuseki.query(`PREFIX rv: <${RV}>
        SELECT ?epoch ?sequence WHERE { GRAPH <${GRAPHS.control}> {
          <${MAIN_RELAY_STREAM_SCOPE}> rv:dataEpoch ?epoch ; rv:streamSequence ?sequence } }`);
      const stream = graph.results?.bindings[0];
      const projection = (await context.pools.content.query(`SELECT c.data_epoch,
        c.sequence::text, c.scan_sequence::text, c.pending_count::text,
        o.data_epoch AS owner_epoch, o.sequence::text AS owner_sequence
        FROM content.projection_checkpoint c CROSS JOIN content.owner_control o
        WHERE c.consumer=$1 AND o.singleton`,
      [context.apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1'])).rows[0];
      let ready = 0;
      try {
        ready = (await fetch(`http://127.0.0.1:${context.apps.MAIN_PORT}/health/ready`,
          { signal: AbortSignal.timeout(2000) })).status;
        readinessFailure = undefined;
      } catch (error) { readinessFailure = error; }
      observed = { relay, graph: stream, projection, ready };
      const converged = relay?.data_epoch === context.apps.MAIN_DATA_EPOCH
        && stream?.epoch?.value === relay.data_epoch && stream?.sequence?.value === relay.sequence
        && projection?.data_epoch === projection?.owner_epoch
        && projection?.sequence === projection?.owner_sequence
        && projection?.scan_sequence === projection?.owner_sequence
        && projection?.pending_count === '0' && ready === 200
        && children.every(worker => readFileSync(worker.log, 'utf8').includes(
          worker.name === 'main' ? '"event":"main_listening"' : '"event":"main_relay_started"'));
      stable = converged ? stable + 1 : 0;
      if (stable >= 3) {
        writeDrillJson(join(artifactDirectory, 'running-workers-convergence.json'), {
          ...observed, elapsedMs: Date.now() - started, stableObservations: stable,
          workers: children.map(({ name, child }) => ({ name, pid: child.pid, running: child.exitCode === null })),
          relayCheckpointConflict: false, missingCustodyBatch: false,
        });
        return;
      }
      await Bun.sleep(1000);
    }
    throw new Error(`Restored production workers did not converge: ${JSON.stringify(observed)}`,
      { cause: readinessFailure });
  }, async () => {
    const stopped = await Promise.allSettled(children.map(({ child }) => new Promise<void>((resolveExit, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolveExit(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Production worker shutdown exceeded 15 seconds')); }, 15_000);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
      child.kill('SIGTERM');
    })));
    const failures = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Production worker shutdown failed', { cause: failures[0] });
  });
}

/** Runs in a fresh process with only the validated, separately retained inputs. */
export async function runIndependentRestoreChild(
  transferFile: string,
  artifactDirectory: string,
  missingCustody: boolean,
): Promise<void> {
  const transfer = assertIndependentRestoreTransfer(JSON.parse(readFileSync(transferFile, 'utf8')));
  const inputs = resolveIndependentRestoreInputs(transfer);
  const samples = physicalRestoreSamples(inputs.expectations);
  const inspector = createIsolationInspector();
  assertIndependentRestoreSourceAbsent(samples.source, inspector);
  const key = readFileSync(inputs.recoveryHmacKey, 'utf8').trim();
  const signingKey = readFileSync(inputs.retainedNativeSigningMaterial, 'utf8').trim();
  const currentEnvelope = readFileSync(inputs.currentAuthorityCoverage, 'utf8').trim();
  const current = openRecoveryPayload<RecoveryCoverage>(currentEnvelope, key, 'graph-recovery-coverage');
  assert(current.nativeAccessErasure);
  assert.equal(resolve(inputs.nativeAccessAttachment),
    join(dirname(inputs.nativeAccessAttachment), `${current.nativeAccessErasure.ciphertextDigest}.gpg`));
  const retained = await importCurrentRelay(currentRelayTransferForDump(inputs.currentRelayDump));
  await preserveRestoreCleanup(async () => {
  const project = missingCustody ? `${samples.project}-held` : samples.project;
  const label = missingCustody ? 'missing-custody' : 'restore';
  const phases = join(artifactDirectory, `${label}-phases.jsonl`);
  const phase = (name: string, facts: Record<string, unknown> = {}) =>
    appendFileSync(phases, `${JSON.stringify({ name, at: new Date().toISOString(), ...facts })}\n`, { mode: 0o600 });
  let reconciledTarget: RestoredContext | undefined;
  const authenticate = {
    verify: async (request: Request) => {
      if (request.headers.get('authorization') !== 'Bearer qa-owner')
        throw new AccountAssertionDenied('denied');
      return samples.operator;
    },
  };
  phase('source-absent-before-target', { source: samples.source.project, childPid: process.pid });
  writeDrillJson(join(artifactDirectory, `${label}-relay-identity.json`), retained.identity);
  assert(!retained.identity.clusterDirectory.startsWith(samples.source.stackDirectory));
  assert(!samples.source.publishedPorts.some(port => port.hostPort === String(retained.identity.port)));
  const retainedBefore = (await retained.relayPool.query(
    'SELECT id, admission_id FROM relay.erasure WHERE id=$1', [samples.erasureId])).rows;
  assert.deepEqual(retainedBefore, [{ id: samples.erasureId, admission_id: samples.admissionId }]);
  const checks: RestoreChecks = {
    verify: async context => {
      assertIndependentRestoreSourceAbsent(samples.source, inspector);
      inspectIndependentRestoreTarget(project, samples.source, inspector);
      assert.notEqual(context.apps.MAIN_DATA_EPOCH, samples.original.dataEpoch);
      assert.notEqual(new URL(context.apps.MAIN_RELAY_DATABASE_URL!).port, String(retained.identity.port));
      assert.equal((await context.pools.relay.query('SELECT id FROM relay.erasure WHERE id=$1',
        [samples.erasureId])).rowCount, 0);
      assert.equal((await context.pools.access.query('SELECT id FROM access.admission WHERE id=$1',
        [samples.admissionId])).rowCount, 0);
      const exact = await new ContentCore(context.pools.content)
        .readExactBatch([samples.revisionId], async ids => new Set(ids));
      assert.equal(exact[0]?.status, 'available');
      assert.equal((await context.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        ASK { GRAPH <${GRAPHS.control}> { <${DATASET}> rv:restoreHold true } }`)).boolean, true);
      phase('immutable-base-verified', { laterErasureAbsent: true });
    },
    reconcile: async (context, body, idempotencyKey) => {
      body = { ...body, retainedAuthorityCoverage: currentEnvelope };
      assert.equal(body.sealedCoverage, context.manifest.sealedCoverage);
      assert.equal(body.retainedAuthorityCoverage, currentEnvelope);
      assert.notEqual(body.sealedCoverage, body.retainedAuthorityCoverage);
      const objects = objectStore(context.apps, context.budget, context.pools.content);
      const environment = {
        fuseki: context.fuseki,
        lineage: { dataEpoch: context.apps.MAIN_DATA_EPOCH!, routingEpoch: context.apps.MAIN_ROUTING_EPOCH! },
        objectDirectory: context.apps.MAIN_OBJECT_DIRECTORY!,
        workObjects: objects.workObjects,
        titleAdmissionKey: signingKey,
        receiptCustody: new ReceiptCustody(new PostgresReceiptCustodyStore(context.pools.access),
          objects.workObjects, context.fuseki, signingKey,
          proofRetirementSender(context.apps.FUSEKI_URL!, context.apps.FUSEKI_COMMAND_TOKEN!)),
      };
      const operations = new OwnerOperations(retained.relayPool, environment, {
        accountPool: context.pools.account, accessPool: context.pools.access,
        contentPool: context.pools.content, restoredRelayPool: context.pools.relay,
        hmacKey: key, objectStore: objects,
        ...(missingCustody ? {} : { nativeAccessAttachment: reference =>
          readNativeAccessAttachment(reference, dirname(inputs.nativeAccessAttachment), process.env) }),
        erasures: { authority: { sealedCoverage: currentEnvelope, hmacKey: key }, signingKey,
          maintenance: heldErasureMaintenanceClient(context.apps.FUSEKI_URL!, context.apps.FUSEKI_MAINTENANCE_TOKEN!),
          originalSource: 'retained-native-event' },
      });
      const app = createMainApp(context.fuseki, {
        environment, account: authenticate, access: new AccessAdmissionRegistry(context.pools.access),
        content: new ContentCore(context.pools.content), ownerOperations: operations,
      });
      assert.equal((await app.handle(new Request('http://main.local/health/ready'))).status, 503);
      const request = (authorization: string) => new Request('http://main.local/v1/owners/reconciliations', {
        method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      });
      assert.equal((await app.handle(request('Bearer denied'))).status, 401);
      const response = await app.handle(request('Bearer qa-owner'));
      const result = await response.clone().json();
      const operation = (await retained.relayPool.query(
        'SELECT state, disposition, hold_reason FROM relay.owner_reconciliation WHERE operation_id=$1',
        [`owner:reconcile:${idempotencyKey}`])).rows[0];
      writeDrillJson(join(artifactDirectory, `${label}-reconciliation.json`),
        { status: response.status, result, operation });
      if (missingCustody) {
        assert.equal(result.state, 'held');
        assert.equal(result.disposition, 'conflict');
        assert.match(operation.hold_reason, /native Access.*(custody|attachment).*unavailable/i);
        assert.deepEqual((await context.pools.access.query(
          'SELECT open, generation::text FROM access.recovery_fence WHERE id=true')).rows,
        [{ open: false, generation: context.manifest.fenceGeneration }]);
        assert.equal((await context.pools.account.query(
          "SELECT rolname FROM pg_roles WHERE rolname IN ('account','access','content','relay') AND rolcanlogin")).rowCount, 0);
        assert.equal((await app.handle(new Request('http://main.local/health/ready'))).status, 503);
        phase('missing-custody-held', { operation });
      } else {
        assert.equal(response.status, 201);
        assert.equal(result.state, 'reconciled', `Owner remained held: ${operation?.hold_reason}`);
        assert.equal(result.disposition, 'matched');
        reconciledTarget = context;
        phase('authenticated-owner-release');
      }
      return response;
    },
    verifyServing: async context => {
      assert.equal(context, reconciledTarget);
      assertIndependentRestoreSourceAbsent(samples.source, inspector);
      inspectIndependentRestoreTarget(project, samples.source, inspector);
      assert.deepEqual((await context.pools.access.query(
        'SELECT open, generation::text FROM access.recovery_fence WHERE id=true')).rows,
      [{ open: true, generation: (BigInt(context.manifest.fenceGeneration) + 1n).toString() }]);
      // The independently retained journal survives release; the original base
      // relay must not be rewritten to conceal the later erasure.
      assert.equal((await context.pools.relay.query('SELECT id FROM relay.erasure WHERE id=$1',
        [samples.erasureId])).rowCount, 0);
      assert.deepEqual((await retained.relayPool.query(
        'SELECT id, admission_id FROM relay.erasure WHERE id=$1', [samples.erasureId])).rows, retainedBefore);
      const objects = objectStore(context.apps, context.budget, context.pools.content);
      const app = createMainApp(context.fuseki, {
        environment: { fuseki: context.fuseki,
          lineage: { dataEpoch: context.apps.MAIN_DATA_EPOCH!, routingEpoch: context.apps.MAIN_ROUTING_EPOCH! },
          objectDirectory: context.apps.MAIN_OBJECT_DIRECTORY!, workObjects: objects.workObjects,
          structureGroupRoots: objects.structureGroupRoots, structureQualifierRoots: objects.structureQualifierRoots,
          titleAdmissionKey: signingKey,
          receiptCustody: new ReceiptCustody(new PostgresReceiptCustodyStore(context.pools.access),
            objects.workObjects, context.fuseki, signingKey,
            proofRetirementSender(context.apps.FUSEKI_URL!, context.apps.FUSEKI_COMMAND_TOKEN!)) },
        account: authenticate, access: new AccessAdmissionRegistry(context.pools.access),
        content: new ContentCore(context.pools.content),
      });
      assert.equal((await app.handle(new Request('http://main.local/health/ready'))).status, 200);
      const workId = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(samples.work)?.[1];
      assert(workId);
      const workUrl = `http://main.local/v1/works/${workId}?actingSubject=${encodeURIComponent(samples.actingSubject)}`;
      assert.equal((await app.handle(new Request(workUrl, { headers: { authorization: 'Bearer denied' } }))).status, 401);
      const authorized = await app.handle(new Request(workUrl, { headers: { authorization: 'Bearer qa-owner' } }));
      assert.equal(authorized.status, 200);
      assert.equal((await authorized.json()).id, samples.work);
      phase('restored-authorized-and-denied-reads', { authorized: 200, denied: 401 });
      if (samples.recipe) {
        assert.deepEqual(await context.fuseki.membershipPreparationStatus(), { needsPreparation: false });
        assert.deepEqual(await readMembershipCompletionProof(context.fuseki), {
          dataEpoch: context.apps.MAIN_DATA_EPOCH!, revision: 'ordered-membership-v1',
        });
        await verifyRunningRestoredWorkers(context, artifactDirectory);
        phase('production-workers-converged', { status: 200, relayCheckpointConflict: false, missingCustodyBatch: false });
      }
      phase('target-ready', { status: 200, generation: (BigInt(context.manifest.fenceGeneration) + 1n).toString() });
    },
  };
  const started = Date.now();
  try {
    const evidence = await restoreRecoverySet({ set: inputs.recoverySet, frontier: inputs.currentFrontier,
      key, project, checks, environment: process.env });
    assert.equal(missingCustody, false, 'Missing custody unexpectedly released');
    assert.equal(evidence.state, 'verified');
    assert.equal(evidence.servingVerified, true);
    assert(evidence.elapsedMs <= 600_000);
    writeDrillJson(join(artifactDirectory, 'restore-timing.json'), evidence);
    for (const [name, elapsedMs] of Object.entries(evidence.phases)) phase(name, { elapsedMs });
  } catch (error) {
    const refusal = findRecoveryRefusal(error);
    await preserveRestoreCleanup(async () => {
      if (!missingCustody || refusal?.code !== 'owner-reconciliation-refused') throw error;
    }, () => phase('failure', { message: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started }));
    assert(refusal);
    writeDrillJson(join(artifactDirectory, 'missing-custody-refusal.json'), { code: refusal.code, elapsedMs: Date.now() - started });
  }
  }, () => retained.close());
}

/** Build the physical cut once, retain later native evidence, then cross the
 * transfer boundary after every source connection and storage owner is gone. */
async function produceIndependentRestoreSource(withRecipe: boolean, context: SourceContext) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR)
    throw new Error('Run through the isolated fault/recovery QA tier');
  const artifactDirectory = join(Bun.env.REZICS_QA_ARTIFACT_DIR, withRecipe ? 'independent-restore' : 'independent-authority');
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  const nonce = randomUUID().replaceAll('-', '').slice(0, 10);
  const sourceRunId = withRecipe ? `fixture-ind-${nonce}` : `ind-source-${nonce}`;
  assert(withRecipe ? /^fixture-[a-z0-9-]{1,27}$/.test(sourceRunId) : /^ind-source-[a-f0-9]{10}$/.test(sourceRunId));
  const source = { profile: 'qa' as const, runId: sourceRunId, persistent: true };
  const project = `rezics-qa-ind-${nonce}`;
  const build = join(repositoryRoot, '.temp', 'ops', `ind-build-${nonce}`);
  const transferRoot = context.backup;
  mkdirSync(build, { recursive: true, mode: 0o700 });
  mkdirSync(transferRoot, { recursive: true, mode: 0o700 });
  const phases = join(artifactDirectory, 'source-phases.jsonl');
  const phaseCosts: Record<string, number> = {};
  const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const at = Date.now();
    const before = context.budget.timing();
    appendFileSync(phases, `${JSON.stringify({ name, event: 'start', at })}\n`, { mode: 0o600 });
    return preserveRestoreCleanup(work, () => {
      const after = context.budget.timing();
      phaseCosts[name] = after.elapsedMs - before.elapsedMs;
      appendFileSync(phases, `${JSON.stringify({ name, event: 'end', elapsedMs: phaseCosts[name],
        admissionWaitMs: after.admissionWaitMs - before.admissionWaitMs, wallMs: Date.now() - at })}\n`);
    });
  };
  const { recoveryTestCustody, closeRecoveryTestCustody, retainedRecoveryAuthority, exportCurrentRelay } =
    await import('./g-727-recovery-checks.ts');
  const custody = recoveryTestCustody(build, nonce);
  const key = randomBytes(32).toString('hex');
  const pools: Pool[] = [];
  let baseCluster: Awaited<ReturnType<typeof startPostgresCluster>> | undefined;
  let sourceDisposed = false;
  let custodyClosed = false;
  const sourceDirectory = stackDirectory(repositoryRoot, source);
  return preserveRestoreCleanup(async () => {
    await timed('source-startup', async () => {
      if (withRecipe) {
        {
          const fixture = compatibleFixture('small');
          assert(fixture, 'A retained compatible small fixture is required; the fixture owner must prepare it before this drill');
          const result = await commandAsync(repositoryRoot, 'task',
            ['fixture:restore', '--', '--fixture', fixture.id, '--run-id', source.runId], 180_000);
          context.budget.excludeAdmissionWait(result.admissionWaitMs);
          if (!result.ok) throw failedCommand(`Writable small-fixture restore failed: ${result.output.slice(-2000)}`, result);
        }
        const evidence = JSON.parse(readFileSync(
          join(repositoryRoot, '.artifacts', 'fixture-restore', source.runId, 'run.json'), 'utf8')) as FixtureRestoreEvidence;
        const manifest = readManifest(evidence.fixture);
        assert(manifest && manifest.profile === 'small');
        assert.equal(evidence.target, source.runId);
        assert.equal(evidence.profile, 'small');
        assert.equal(evidence.works, manifest.entities.works);
        assert.equal(evidence.failure, undefined);
        assert(evidence.completedAt && evidence.elapsedMs !== undefined && evidence.elapsedMs <= 600_000);
        writeDrillJson(join(artifactDirectory, 'source-fixture-inventory.json'), evidence);
      } else {
        const result = await runQaStartupChildAsync(repositoryRoot,
          ['stack:up', '--profile', 'qa', '--run-id', source.runId, '--persistent'], 180_000);
        context.budget.excludeAdmissionWait(result.admissionWaitMs);
        if (!result.ok) throw new Error(`Source startup failed: ${result.output.slice(-2000)}`, { cause: result.error });
      }
    });
    const apps = readEnv(join(sourceDirectory, 'apps.env'));
    const saved = readEnv(join(sourceDirectory, 'compose.env'));
    await migrateFixtureOwners(apps);
    const owner = (name: string) => {
      const pool = new Pool({ connectionString: administratorUrl(saved, name), max: 4 });
      pool.on('error', () => {});
      pools.push(pool);
      return pool;
    };
    const owners = { account: owner('account'), access: owner('access'), content: owner('content'), relay: owner('relay') };
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN, apps.FUSEKI_COMMAND_TOKEN);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    if (!withRecipe) await initializeFreshGraph(fuseki, lineage);
    const objects = objectStore(apps, undefined, owners.content);
    await objects.workObjects.initialize();
    await objects.structureObjects.initialize();
    const environment = { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
      workObjects: objects.workObjects, structureGroupRoots: objects.structureGroupRoots,
      structureQualifierRoots: objects.structureQualifierRoots, titleAdmissionKey: apps.FUSEKI_TITLE_ADMISSION_KEY!,
      receiptCustody: new ReceiptCustody(new PostgresReceiptCustodyStore(owners.access), objects.workObjects,
        fuseki, apps.FUSEKI_TITLE_ADMISSION_KEY!, proofRetirementSender(apps.FUSEKI_URL!, apps.FUSEKI_COMMAND_TOKEN!)) };
    await ensureModelGeneration(environment);
    const sample = await seedRecoveryContent(environment, owners.content, owners.access);
    const registry = new AccessAdmissionRegistry(owners.access, apps.FUSEKI_TITLE_ADMISSION_KEY);
    const principalId = await registry.activePrincipalId(sample.content.principal);
    assert(principalId);
    const actor = sample.content.actingSubject;
    const grant = async (scope: string, action: string) => {
      await grantFixtureAuthority(owners.access, { scope, requireDispatch: false,
        representations: [{ principalId, actor, action, lifetime: '8 hours' }],
        grant: { actor, action, lifetime: '8 hours' } });
    };
    await grant(`erasure:${sample.works[0]!}`, 'erasure.request');
    await grant(`work:read:${sample.works[0]!}`, 'work.read');
    let recipe: RecipeSeed | undefined;
    if (withRecipe) {
      await provisionFixtureAuthor(environment, actor);
      await grant('work:create:root', 'work.create');
      const request = createRecipeApiRequest(fuseki, { environment,
        structureObjects: objects.structureObjects, account: { verify: async () => sample.content.principal },
        access: registry, content: new ContentCore(owners.content) }, async () => 'qa-source');
      recipe = await seedRecipeBeforeCut({ request, actor, grant });
      writeDrillJson(join(artifactDirectory, 'recipe-seed.json'), recipe);
      const prepared = await timed('source-membership', () =>
        normalizeStoredMembership(environment, 256, Date.now() + 180_000));
      assert.equal(prepared.complete, true);
      assert.deepEqual(await readMembershipCompletionProof(fuseki), {
        dataEpoch: lineage.dataEpoch, revision: 'ordered-membership-v1',
      });
    }
    await initializeRelayCheckpoint(owners.relay, apps.MAIN_RELAY_CONSUMER!, lineage.dataEpoch);
    const drain = async () => {
      while (await relayMainOutboxOnce(fuseki, owners.relay, apps.MAIN_RELAY_CONSUMER!,
        { ownerOutbox: environment.receiptCustody })) { /* ordered native custody */ }
    };
    await drain();
    const set = join(build, 'set');
    const frontier = join(build, 'current-frontier.json');
    const backup = await timed('backup', () => backupRecoverySet({ out: set, frontier, source,
      key, recipient: custody.recipient, environment: custody.publicOnly }));
    context.budget.excludeAdmissionWait(backup.phases.memoryAdmission ?? 0);
    writeDrillJson(join(artifactDirectory, 'backup-timing.json'), backup);
    const baseAuthority = await retainedRecoveryAuthority(set, key, custody.offhost);
    const base = openRecoveryPayload<RecoveryCoverage>(baseAuthority.sealedCoverage, key, 'graph-recovery-coverage');
    const setDigests = Object.fromEntries(await Promise.all([...artifactNames, 'set.json'].map(async name =>
      [name, await Bun.file(join(set, name)).bytes().then(bytes => new Bun.CryptoHasher('sha256').update(bytes).digest('hex'))])));
    const sourceBudget = new RecoveryBudget();
    const sourceContext = stackContext(source, sourceBudget);
    await sourceContext.startup(() => sourceContext.compose(['up', '-d', '--wait', 'postgres', 'fuseki', 'rustfs']),
      { services: ['postgres', 'fuseki', 'rustfs'] });
    context.budget.excludeAdmissionWait(sourceBudget.timing().admissionWaitMs);
    // Backup has already reopened the source fence. Read C0 from its immutable
    // physical artifact, never from the subsequently reopened source or by
    // rewriting a snapshot fence to resemble the signed cut.
    const baseDirectory = join(build, 'base-postgres');
    const baseArchive = join(build, 'base-postgres.tar');
    const index = openIndex(readFileSync(join(set, 'set.json'), 'utf8'), key);
    const postgresArtifact = index.artifacts.find(item => item.file === 'postgres.tar.gpg');
    assert(postgresArtifact);
    assert.equal(await fileDigest(join(set, postgresArtifact.file)), postgresArtifact.sha256);
    execFileSync('gpg', ['--batch', '--no-tty', '--output', baseArchive,
      '--decrypt', join(set, postgresArtifact.file)], { env: custody.offhost, timeout: 180_000 });
    await assertSafeTar(baseArchive, new RecoveryBudget());
    mkdirSync(baseDirectory, { mode: 0o700 });
    execFileSync('tar', ['-xf', baseArchive, '-C', baseDirectory], { timeout: 180_000 });
    assertRegularTree(baseDirectory);
    execFileSync('pg_verifybackup', [baseDirectory], { timeout: 180_000 });
    appendFileSync(join(baseDirectory, 'postgresql.auto.conf'), "\narchive_mode = off\nrestore_command = 'false'\n");
    writeFileSync(join(baseDirectory, 'recovery.signal'), '', { mode: 0o600 });
    baseCluster = await startPreparedPostgresCluster(baseDirectory, { role: 'postgres' });
    const basePools: Record<string, Pool> = {};
    for (const name of ['access', 'relay']) {
      const url = administratorUrl({ ...saved, POSTGRES_PORT: String(baseCluster.port) }, name);
      basePools[name] = new Pool({ connectionString: url, max: 2 });
      pools.push(basePools[name]!);
    }
    assert(base.accessFenceGeneration);
    assert.deepEqual((await basePools.access!.query(
      'SELECT open, generation::text FROM access.recovery_fence WHERE id=true')).rows,
    [{ open: false, generation: base.accessFenceGeneration }]);
    assert.deepEqual((await owners.access.query(
      'SELECT open, generation::text FROM access.recovery_fence WHERE id=true')).rows,
    [{ open: true, generation: (BigInt(base.accessFenceGeneration) + 1n).toString() }]);
    const app = createMainApp(fuseki, { environment, account: { verify: async () => sample.content.principal },
      access: registry, content: new ContentCore(owners.content),
      erasures: new ErasureService(owners.relay, owners.content, owners.access) });
    const response = await app.handle(new Request('http://main.local/v1/erasures', {
      method: 'POST', headers: { authorization: 'Bearer qa-source', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'content-revision-erasure-v1', resourceId: sample.works[0],
        actingSubject: actor, revisionIds: [sample.content.revisionId] }),
    }));
    const erasure = await response.json() as { erasureId: string; erasureEpoch: string; replayed: boolean };
    assert.equal(response.status, 200, `Later public erasure failed: ${JSON.stringify(erasure)}`);
    assert.equal(erasure.replayed, false);
    await drain();
    const currentGeneration = await engageAccessRecoveryFence(owners.access);
    const baseGeneration = (await basePools.access!.query('SELECT generation::text FROM access.recovery_fence WHERE id=true')).rows[0].generation;
    assert.equal(currentGeneration, (BigInt(baseGeneration) + 2n).toString());
    let attachment: EncryptedRecoveryAttachment<AccessErasureRecoverySummary> | undefined;
    const captureClient = await owners.relay.connect();
    const current = await preserveRestoreCleanup(async () => {
    try {
      await captureClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await captureClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
      const captured = await timed('current-capture', () => captureGraphRecoveryCoverage(fuseki,
        owners.account, owners.access, owners.relay, apps.MAIN_RELAY_CONSUMER!, owners.content, objects,
        { fuseki, relayClient: captureClient }, { baseCoverage: base,
          baseCoverageEnvelope: baseAuthority.sealedCoverage, baseCoverageHmacKey: key,
          baseAccessPool: basePools.access!, baseRelayPool: basePools.relay!,
          encryptAttachment: async produce => {
            attachment = await encryptRecoveryAttachment(custody.recipient, join(build, 'attachments'), produce, custody.publicOnly);
            return attachment;
          } }));
      await captureClient.query('COMMIT');
      return captured;
    } catch (error) {
      return preserveRestoreCleanup(async () => { throw error; }, async () => { await captureClient.query('ROLLBACK'); });
    }
    }, () => captureClient.release());
    assert(current.nativeAccessErasure && attachment);
    const currentEnvelope = seal(current, key, 'graph-recovery-coverage');
    await retainRecoveryCoverageHead(owners.relay, currentEnvelope, key, { attachmentDirectory: join(build, 'attachments') });
    assert.equal(await retainErasureCoverage(owners.relay, apps.MAIN_RELAY_CONSUMER!), erasure.erasureEpoch);
    const admissionId = (await owners.relay.query('SELECT admission_id FROM relay.erasure WHERE id=$1', [erasure.erasureId])).rows[0].admission_id as string;
    assert.equal((await basePools.relay!.query('SELECT id FROM relay.erasure WHERE id=$1', [erasure.erasureId])).rowCount, 0);
    assert.equal((await basePools.access!.query('SELECT id FROM access.admission WHERE id=$1', [admissionId])).rowCount, 0);
    const original = await readGraphErasureProof(fuseki, lineage, erasure.erasureId, erasure.erasureEpoch, [sample.content.revisionId]);
    const inspector = createIsolationInspector();
    const rdfCut = await fuseki.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
    writeFileSync(join(transferRoot, 'rdf-current.json'), stable(rdfCut), { mode: 0o600 });
    const inventory = recordIndependentRestoreSourceInventory(sourceContext.project, sourceDirectory, apps.MAIN_OBJECT_DIRECTORY!, inspector);
    writeDrillJson(join(artifactDirectory, 'source-inventory.json'), inventory);
    sourceContext.compose(['stop', 'fuseki', 'rustfs', 'postgres']);
    const relay = await exportCurrentRelay(source, join(build, 'retained-relay'));
    const relayDump = resolve(repositoryRoot, relay.relayDump);
    for (const [name, digest] of Object.entries(setDigests)) {
      assert.equal(new Bun.CryptoHasher('sha256').update(await Bun.file(join(set, name)).bytes()).digest('hex'), digest);
    }
    closeRecoveryTestCustody(custody);
    custodyClosed = true;
    mkdirSync(join(transferRoot, 'set'), { mode: 0o700 });
    for (const name of [...artifactNames, 'set.json']) cpSync(join(set, name), join(transferRoot, 'set', name));
    cpSync(frontier, join(transferRoot, 'current-frontier.json'));
    mkdirSync(join(transferRoot, 'current-relay'), { mode: 0o700 });
    cpSync(relayDump, join(transferRoot, 'current-relay', 'relay.dump'));
    cpSync(custody.offhost.GNUPGHOME!, join(transferRoot, 'recipient-keys'), { recursive: true });
    mkdirSync(join(transferRoot, 'attachments'), { mode: 0o700 });
    const attachmentName = `${current.nativeAccessErasure.ciphertextDigest}.gpg`;
    cpSync(attachment.path, join(transferRoot, 'attachments', attachmentName));
    writeFileSync(join(transferRoot, 'current-authority.json'), currentEnvelope, { mode: 0o600 });
    writeFileSync(join(transferRoot, 'recovery-hmac.key'), key, { mode: 0o600 });
    writeFileSync(join(transferRoot, 'native-signing.key'), apps.FUSEKI_TITLE_ADMISSION_KEY!, { mode: 0o600 });
    const samples: PhysicalRestoreSamples = { source: inventory, project, work: sample.works[0]!,
      revisionId: sample.content.revisionId, actingSubject: actor, operator: sample.content.principal,
      erasureId: erasure.erasureId, erasureEpoch: erasure.erasureEpoch, admissionId, original,
      ...(recipe ? { recipe } : {}) };
    const encoded = JSON.stringify(samples);
    writeDrillJson(join(transferRoot, 'expectations.json'), {
      format: 'rezics-independent-restore-expectations-v1',
      samples: [{ name: 'erasedRevision', id: samples.revisionId }],
      values: Array.from({ length: Math.ceil(encoded.length / 4000) }, (_, index) =>
        ({ name: `sample${index}`, value: encoded.slice(index * 4000, (index + 1) * 4000) })),
      originalReceiptTuples: [[original.receipt, original.dataEpoch, original.sequence]],
    });
    const transfer: IndependentRestoreTransfer = {
      format: 'rezics-independent-restore-inputs-v1', root: relative(repositoryRoot, transferRoot),
      inputs: { recoverySet: 'set', currentFrontier: 'current-frontier.json',
        currentAuthorityCoverage: 'current-authority.json', nativeAccessAttachment: `attachments/${attachmentName}`,
        currentRelayDump: 'current-relay/relay.dump', recipientPrivateKeyCustody: 'recipient-keys',
        recoveryHmacKey: 'recovery-hmac.key', retainedNativeSigningMaterial: 'native-signing.key' },
      expectations: 'expectations.json',
    };
    const transferFile = join(transferRoot, 'transfer.json');
    writeFileSync(transferFile, serializeIndependentRestoreTransfer(transfer), { mode: 0o600 });
    resolveIndependentRestoreInputs(transfer);
    writeDrillJson(join(artifactDirectory, 'operator-input-inventory.json'), {
      transfer, baseArtifactDigests: setDigests, currentCaptureDigest: new Bun.CryptoHasher('sha256').update(currentEnvelope).digest('hex'),
      attachmentDigest: current.nativeAccessErasure.ciphertextDigest,
      sourceInventory: inventory, credentials: 'encrypted configuration plus independently retained keys',
    });
    await Promise.all(pools.map(pool => pool.end()));
    pools.length = 0;
    baseCluster.remove();
    baseCluster = undefined;
    disposeIndependentRestoreSource(inventory, sourceContext, inspector);
    sourceDisposed = true;
    rmSync(build, { recursive: true, force: true });
    assertIndependentRestoreSourceAbsent(inventory, inspector);
    context.budget.remaining();
    return {
      metadata: { contract: 'independent-restore-source-v1', withRecipe,
        transfer, samples, setDigests, currentEnvelope,
        attachmentDigest: current.nativeAccessErasure.ciphertextDigest },
      rdfDigest: sha256(stable(rdfCut)),
      ownerState: { baseArtifactDigests: setDigests, original, admissionId,
        currentCaptureDigest: sha256(currentEnvelope),
        attachmentDigest: current.nativeAccessErasure.ciphertextDigest },
      producerRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
      qaIdentity: Bun.env.REZICS_QA_RUN_ID!, phases: phaseCosts,
    };
  }, async () => {
    const cleanup = await Promise.allSettled([
      ...pools.map(pool => pool.end()),
      Promise.resolve().then(() => baseCluster?.remove()),
      Promise.resolve().then(() => { if (!custodyClosed) closeRecoveryTestCustody(custody); }),
    ]);
    for (const runId of [source.runId]) {
      if (sourceDisposed && runId === source.runId) continue;
      try {
        const result = await runQaAdmissionChildAsync(repositoryRoot, 'task', ['stack:reset', '--', '--profile', 'qa', '--run-id', runId, '--persistent'], 180_000);
        context.budget.excludeAdmissionWait(result.admissionWaitMs);
        if (!result.ok) await preserveRestoreCleanup(async () => { throw failedCommand(`Stack cleanup failed: ${runId}`, result); }, () => {
          writeFileSync(join(artifactDirectory, `cleanup-${runId}.log`), result.output, { mode: 0o600 });
        });
      } catch (error) { cleanup.push({ status: 'rejected', reason: error }); }
    }
    for (const directory of [build]) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { cleanup.push({ status: 'rejected', reason: error }); }
    }
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Independent restore cleanup failed', { cause: failures[0] });
  });
}

type IndependentCandidate = { directory: string; transferFile: string; transfer: IndependentRestoreTransfer };

/** The producer owns cut/capture; consumers only verify custody and copy bytes. */
export function independentRestoreSourceAdapter(withRecipe: boolean,
  compatibility: RetainedOwnerState = JSON.parse(JSON.stringify({ engines: currentEngines(dockerEnvironment()),
    modelGeneration: fixtureModel(repositoryRoot).generation,
    postgresNative: execFileSync('pg_config', ['--version'], { encoding: 'utf8' }).trim() })) as RetainedOwnerState,
): RetainedSourceAdapter<RetainedOwnerState, IndependentCandidate> {
  const modules = producerModules(repositoryRoot, [
    'tests/qa/fault-recovery/independent-restore-support.ts',
    'tests/qa/fault-recovery/g-727-recovery-checks.ts',
    'scripts/dev/cli.ts', 'scripts/fixture/cli.ts',
    'infra/dev/compose.yaml', 'infra/dev/postgres/00-owners.sh',
    'yarn.lock', 'package.json',
  ]);
  return {
    specification: {
      producer: withRecipe ? 'independent-recipe-source' : 'independent-authority-source', version: '1',
      files: { ...sourceFileDigests(repositoryRoot, modules), ...migrationInventory(repositoryRoot) },
      inputs: { withRecipe },
      compatibility,
    },
    build: async context => {
      const result = await produceIndependentRestoreSource(withRecipe, context);
      return { ...result, metadata: JSON.parse(JSON.stringify(result.metadata)) as RetainedOwnerState,
        ownerState: JSON.parse(JSON.stringify(result.ownerState)) as RetainedOwnerState };
    },
    verify: async (context, manifest) => {
      const evidence: string[] = [];
      const metadata = manifest.metadata;
      if (metadata.contract !== 'independent-restore-source-v1' || metadata.withRecipe !== withRecipe)
        evidence.push('independent source contract differs');
      const transfer = assertIndependentRestoreTransfer(JSON.parse(readFileSync(join(context.backup, 'transfer.json'), 'utf8')));
      if (stable(transfer) !== stable(metadata.transfer)) evidence.push('transfer descriptor differs');
      // Validate physical bytes at their retained location, never the producer's old root.
      const inputs = resolveIndependentRestoreInputs({ ...transfer, root: relative(repositoryRoot, context.backup) });
      const samples = physicalRestoreSamples(inputs.expectations);
      if (stable(samples) !== stable(metadata.samples)) evidence.push('expected source samples differ');
      assertIndependentRestoreSourceAbsent(samples.source, createIsolationInspector());
      if (await fileDigest(join(context.backup, 'rdf-current.json')) !== manifest.integrity.rdfDigest)
        evidence.push('retained RDF digest differs');
      const digests = metadata.setDigests as Record<string, string>;
      if (stable(digests) !== stable(manifest.integrity.ownerState.baseArtifactDigests))
        evidence.push('base artifact custody differs');
      for (const name of [...artifactNames, 'set.json'])
        if (await fileDigest(join(inputs.recoverySet, name)) !== digests[name]) evidence.push(`base artifact differs: ${name}`);
      if (sha256(readFileSync(inputs.currentAuthorityCoverage, 'utf8')) !== manifest.integrity.ownerState.currentCaptureDigest)
        evidence.push('current authority custody differs');
      if (await fileDigest(inputs.nativeAccessAttachment) !== manifest.integrity.ownerState.attachmentDigest)
        evidence.push('native Access attachment custody differs');
      return evidence;
    },
    restore: async (context, manifest) => {
      const directory = join(repositoryRoot, '.temp', 'ops', `ind-copy-${randomUUID()}`);
      try {
        cpSync(context.backup, directory, { recursive: true, errorOnExist: true, force: false,
          // RDF inventory proves retained custody; it is not a restore input.
          filter: source => source !== join(context.backup, 'rdf-current.json') });
        const transfer = { ...(manifest.metadata.transfer as unknown as IndependentRestoreTransfer),
          root: relative(repositoryRoot, directory) };
        // A writable copy gets its own target identity; original receipts stay exact.
        const samples = physicalRestoreSamples(join(directory, transfer.expectations));
        samples.project = `rezics-qa-ind-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
        writePhysicalRestoreSamples(join(directory, transfer.expectations), samples);
        const transferFile = join(directory, 'transfer.json');
        writeFileSync(transferFile, serializeIndependentRestoreTransfer(transfer), { mode: 0o600 });
        resolveIndependentRestoreInputs(transfer);
        context.budget.remaining();
        return { directory, transferFile, transfer };
      } catch (error) {
        return preserveRestoreCleanup(async () => { throw error; }, () => rmSync(directory, { recursive: true, force: true }));
      }
    },
    dispose: async candidate => {
      const samples = physicalRestoreSamples(join(candidate.directory, candidate.transfer.expectations));
      for (const project of [samples.project, `${samples.project}-held`]) {
        const result = await runQaAdmissionChildAsync(repositoryRoot, 'task',
          ['stack:reset', '--', '--profile', 'qa', '--run-id', project.slice('rezics-qa-'.length), '--persistent'], 180_000);
        if (!result.ok) throw failedCommand(`Stack cleanup failed: ${project}`, result);
      }
      rmSync(candidate.directory, { recursive: true, force: true });
    },
    // All custody is in backup files; the lifecycle removes staging itself.
    remove: async () => {},
  };
}

function writePhysicalRestoreSamples(path: string, samples: PhysicalRestoreSamples): void {
  const encoded = JSON.stringify(samples);
  writeDrillJson(path, {
    format: 'rezics-independent-restore-expectations-v1',
    samples: [{ name: 'erasedRevision', id: samples.revisionId }],
    values: Array.from({ length: Math.ceil(encoded.length / 4000) }, (_, index) =>
      ({ name: `sample${index}`, value: encoded.slice(index * 4000, (index + 1) * 4000) })),
    originalReceiptTuples: [[samples.original.receipt, samples.original.dataEpoch, samples.original.sequence]],
  });
}

/** Restore never prepares, supplements or reseals retained custody. */
export async function runIndependentRestoreDrill(withRecipe: boolean, refusalsOnly = false): Promise<void> {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR)
    throw new Error('Run through the isolated fault/recovery QA tier');
  const artifactDirectory = join(Bun.env.REZICS_QA_ARTIFACT_DIR,
    refusalsOnly ? 'independent-refusals' : withRecipe ? 'independent-restore' : 'independent-authority');
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  const adapter = independentRestoreSourceAdapter(withRecipe);
  const selectedKey = process.env.INDEPENDENT_RESTORE_SOURCE_KEY;
  if (selectedKey !== undefined && selectedKey !== sourceKey(adapter.specification))
    throw new RetainedSourceRefusal(selectedKey, ['harness selected incompatible independent source']);
  const restored = await new RetainedSources().restore(adapter);
  writeDrillJson(join(artifactDirectory, 'retained-source.json'), {
    key: restored.manifest.key, digest: restored.manifest.digest,
    elapsedMs: restored.elapsedMs, admissionWaitMs: restored.admissionWaitMs,
  });
  await preserveRestoreCleanup(async () => {
    const { directory, transferFile, transfer } = restored.candidate;
    const inputs = resolveIndependentRestoreInputs(transfer);
    const inventory = physicalRestoreSamples(inputs.expectations).source;
    const inspector = createIsolationInspector();
    const childEnvironment = preserveReapEnvironment(createIndependentRestoreChildEnvironment(process.env, inputs));
    const childScript = join(directory, 'restore-child.ts');
    writeFileSync(childScript, `import { runIndependentRestoreChild, recordIndependentRestoreChildFailure } from ${JSON.stringify(import.meta.path)};\nawait recordIndependentRestoreChildFailure(process.argv[5]!, () => runIndependentRestoreChild(process.argv[2]!, process.argv[3]!, process.argv[4] === 'missing'));\n`, { mode: 0o600 });
    const phases = join(artifactDirectory, 'source-phases.jsonl');
    for (const mode of refusalsOnly ? ['missing'] : withRecipe ? ['positive'] : ['missing', 'positive']) {
      assertIndependentRestoreSourceAbsent(inventory, inspector);
      const at = Date.now();
      const failureFile = join(artifactDirectory, `child-${mode}-failure.json`);
      const result = await runQaAdmissionChildAsync(repositoryRoot, 'bun',
        [childScript, transferFile, artifactDirectory, mode, failureFile], 180_000, childEnvironment);
      appendFileSync(phases, `${JSON.stringify({ name: `child-${mode}`, elapsedMs: result.activeElapsedMs,
        admissionWaitMs: result.admissionWaitMs, wallMs: Date.now() - at })}\n`, { mode: 0o600 });
      writeFileSync(join(artifactDirectory, `child-${mode}.log`), result.output, { mode: 0o600 });
      if (!result.ok) throw new Error(`Independent restore child ${mode} failed: ${result.output.slice(-5000)}`,
        { cause: existsSync(failureFile) ? readIndependentRestoreChildFailure(failureFile)
          : failedCommand('Restore child terminated before recording its failure', result) });
    }
  }, () => restored.dispose());
}

if (import.meta.main) {
  const evidenceIndex = process.argv.indexOf('--evidence');
  if (!process.argv.includes('--prepare-retained-source') || evidenceIndex < 0 || !process.argv[evidenceIndex + 1])
    throw new Error('select --prepare-retained-source --evidence <path>');
  const adapter = independentRestoreSourceAdapter(process.argv.includes('--recipe'));
  const sources = new RetainedSources();
  const selected = process.argv.includes('--retained-only');
  const report = selected ? { manifest: await sources.select(adapter), built: false }
    : await sources.prepare(adapter);
  writeDrillJson(process.argv[evidenceIndex + 1]!, report);
}
