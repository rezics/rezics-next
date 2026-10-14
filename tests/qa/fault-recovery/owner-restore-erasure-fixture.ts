import { expect } from 'bun:test';
import { Elysia } from 'elysia';
import { decodeJwt } from 'jose';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { ACCOUNT_RECOVERY_USAGE_EXCLUSIONS } from '../../../services/account/src/recovery-coverage.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import {
  ContentComments,
  contentCommentIntentDigest,
} from '../../../services/content/src/comments.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { VerificationStore } from '../../../services/main/src/modules/verification/store.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { StructureGroupRootStore } from '../../../services/main/src/modules/structure/group-root.ts';
import { StructureQualifierRootStore } from '../../../services/main/src/modules/structure/qualifier-index.ts';
import { normalizeStoredMembership } from '../../../services/main/src/modules/structure/membership-normalize.ts';
import {
  ObjectIntegrityError,
  ObjectUnavailable,
  type ImmutableObjects,
} from '../../../services/main/src/infrastructure/immutable-objects.ts';
import {
  AccessAdmissionRegistry,
  engageAccessRecoveryFence,
  releaseAccessRecoveryFence,
} from '../../../services/main/src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { AccessDownloadLeases } from '../../../services/main/src/modules/access/download-leases.ts';
import type { AccessErasureRecoverySummary } from '../../../services/main/src/modules/access/erasure-recovery.ts';
import { ContentSearchReadAccess } from '../../../services/main/src/modules/search-disclosure/content-read-lease.ts';
import { applyContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import {
  heldErasureMaintenanceClient,
  readGraphErasureProof,
  suppressGraphContentRevisions,
} from '../../../services/main/src/modules/erasure/graph.ts';
import {
  ensureRetentionDomain,
  journalErasure,
  markErasureSuppressed,
  recordErasureInventory,
} from '../../../services/main/src/modules/erasure/journal.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { retainErasureCoverage } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import {
  PostgresReceiptCustodyStore,
  ReceiptCustody,
} from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import type { PreparedCommand } from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import {
  initializeRelayCheckpoint,
  relayMainOutboxOnce,
} from '../../../services/main/src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import {
  OwnerOperations,
  readNativeAccessAttachment,
  type RestoreResources,
} from '../../../services/main/src/modules/owner/operations.ts';
import { ensureModelGeneration } from '../../../services/main/src/modules/semantic/command.ts';
import {
  DATASET,
  GRAPHS,
  RV,
  hash,
  initializeFreshGraph,
  type WorkActivationEnvironment,
} from '../../../services/main/src/modules/work/activate.ts';
import {
  commitMetadata,
  readMetadataReceipt,
} from '../../../services/main/src/modules/work/metadata-command.ts';
import {
  checkedMetadataState,
  metadataDigest,
  type MetadataIntent,
} from '../../../services/main/src/modules/work/metadata-schema.ts';
import {
  captureGraphRecoveryCoverage,
  cutoverRestoredGraphLineage,
  RestoreLineageConflict,
  type RecoveryCoverage,
} from '../../../services/main/src/modules/work/restore-lineage.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import {
  accessOutboxCoverage,
  accessStateCoverage,
} from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import {
  finishOperatorRestore,
  type OperatorRestoreReleaseContext,
  type RestoreChecks,
} from '../../../scripts/ops/restore.ts';
import {
  encryptRecoveryAttachment,
  RecoveryBudget,
  type EncryptedRecoveryAttachment,
} from '../../../scripts/ops/recovery-set.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { healthRoutes } from '../../../services/main/src/routes/health.ts';
import { erasureRoutes } from '../../../services/main/src/routes/erasures.ts';
import { ownerRoutes } from '../../../services/main/src/routes/owners.ts';
import { ratingAccount, restoreRatingAccount, type RetainedRatingAuth } from '../../../tests/qa/support/rating-account.ts';
import { stable } from '../../../scripts/fixture/corpus.ts';
import { copyVolume, currentEngines, fixtureProject, postgresImage, removeVolumes, run, volumeExists } from '../../../scripts/fixture/stack.ts';
import { isRetainedJson, migrationInventory, type RetainedFileIntegrity, type RetainedJson, type RetainedOwnerState } from '../../../scripts/fixture/manifest.ts';
import { fixtureModel } from '../../../scripts/fixture/model.ts';
import { RetainedSourceRefusal, RetainedSources, sourceFileDigests, sourceKey, type RetainedSourceAdapter, type SourceContext, type RetainedSourceManifest } from '../../../scripts/qa/retained-source.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { deliverRetainedContentEligibilityOnce } from '../../../services/main/src/modules/content-publication/eligibility-delivery.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { copyRecoveryTree } from '../../../tests/qa/support/recovery-copy.ts';
import { provisionFixtureAuthor } from '../../../tests/qa/fixtures/authored-work.ts';
import {
  createRecipeApiRequest,
  readMembershipCompletionProof,
  type BeforeCutRecipeSeedContext,
  type MembershipCompletionProof,
  type RecipeApiRequest,
} from './operator-restore-recipe-support.ts';
import {
  createRestoreFixtureTiming,
  type RestoreFixturePhaseHandle,
} from '../../../tests/qa/support/restore-fixture-timing.ts';
import { seedContent } from '../../../tests/qa/load/corpus.ts';
import { closeRecoveryTestCustody, recoveryTestCustody } from './g-727-recovery-checks.ts';
import {
  freePort,
  fusekiSecrets,
  pinnedImage,
  qaStack,
  requireFaultTier,
  standaloneFuseki,
  type StandaloneFuseki,
} from '../../../tests/qa/fault-recovery/search-ops-support.ts';

export const restoreKey = 'e6'.repeat(32);

export interface OwnerRestoreErasureFixtureOptions {
  /** Foreground API population returns JSON proof identities for later isolated consumers. */
  beforeCutApiSeed?: (context: BeforeCutRecipeSeedContext) => Promise<unknown>;
  /** A callback cannot share the default source key; its authored identity/inputs are required. */
  beforeCutSource?: { identity: string; inputs: RetainedOwnerState; files: string[] };
  /** Admit one completed revision erasure through the public API after the base backup. */
  laterApiAdmission?: boolean;
}

interface LaterAdmissionEvidence {
  idempotencyKey: string;
  admissionId: string;
  erasureId: string;
  erasureEpoch: string;
  baseGeneration: string;
  currentGeneration: string;
  accountChanges: AccountRowChange[];
}

interface AccountRowChange {
  table: string;
  keyDigest: string;
  kind: 'inserted' | 'deleted' | 'updated';
  columns: string[];
}

type AccountRows = Map<string, Map<string, Record<string, unknown>>>;

export function expectReviewedAccountUsageChanges(changes: AccountRowChange[]): void {
  const exclusions: Readonly<Record<string, readonly string[]>> =
    ACCOUNT_RECOVERY_USAGE_EXCLUSIONS.columns;
  const unreviewed = changes.filter(change => change.kind !== 'updated' ||
    change.columns.some(column => !exclusions[change.table]?.includes(column)));
  // Resource-use timestamps are throttled, so a fast C0 -> C1 run may change no rows.
  expect(unreviewed, `C0/C1 Account row changes: ${JSON.stringify(changes)}`).toEqual([]);
}

// Measure whole rows, independently of the authority digest's usage projection.
// Keep credential values in memory only; reports identify keys by digest.
async function accountRows(pool: Pool): Promise<AccountRows> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const catalog = await client.query<{ table_name: string; keys: string[] }>(
      `SELECT c.relname AS table_name, array_agg(a.attname::text ORDER BY k.ordinality) AS keys
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
       WHERE n.nspname='public' AND c.relkind='r' GROUP BY c.relname ORDER BY c.relname`);
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
    expect(catalog.rows.map(row => row.table_name)).toEqual(tables.rows.map(row => row.table_name));
    const result: AccountRows = new Map();
    for (const { table_name: table, keys } of catalog.rows) {
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const rows = await client.query<{ key: string; body: Record<string, unknown> }>(
        `SELECT jsonb_build_array(${keys.map(quote).join(', ')})::text AS key,
          to_jsonb(t) AS body FROM public.${quote(table)} AS t`);
      result.set(table, new Map(rows.rows.map(row => [row.key, row.body])));
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function changedAccountRows(base: AccountRows, current: AccountRows): AccountRowChange[] {
  expect([...current.keys()]).toEqual([...base.keys()]);
  const changes: AccountRowChange[] = [];
  for (const [table, before] of base) {
    const after = current.get(table)!;
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const oldRow = before.get(key), newRow = after.get(key);
      const columns = [...new Set([...Object.keys(oldRow ?? {}), ...Object.keys(newRow ?? {})])]
        .filter(column => JSON.stringify(oldRow?.[column]) !== JSON.stringify(newRow?.[column]))
        .sort();
      if (columns.length) changes.push({ table, keyDigest: hash(key),
        kind: !oldRow ? 'inserted' : !newRow ? 'deleted' : 'updated', columns });
    }
  }
  return changes;
}

class DirectoryObjects implements ImmutableObjects {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }
  async put(bytes: Uint8Array): Promise<string> {
    const digest = hash(bytes);
    writeFileSync(join(this.directory, digest), bytes);
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.directory, digest));
    } catch {
      throw new ObjectUnavailable('retained fixture object is missing');
    }
    if (hash(bytes) !== digest)
      throw new ObjectIntegrityError('retained fixture object is corrupt');
    return bytes;
  }
}

export interface RestoreCleanupAction {
  resource: string;
  run: () => void | Promise<void>;
}

export interface RestoreCleanupFailure {
  action: RestoreCleanupAction;
  error: unknown;
}

export interface RestoreGraphResourceOwner {
  readonly containers: readonly StandaloneFuseki[];
  readonly volumes: readonly string[];
  registerContainer(container: StandaloneFuseki): void;
  registerVolume(name: string): void;
  unregisterVolume(name: string): void;
  removeContainer(container: StandaloneFuseki): Promise<void>;
  containerCleanupActions(): RestoreCleanupAction[];
  volumeCleanupActions(removeVolume: (name: string) => void): RestoreCleanupAction[];
}

export function createRestoreGraphResourceOwner(): RestoreGraphResourceOwner {
  const containers: StandaloneFuseki[] = [];
  const volumes: string[] = [];
  const unregisterContainer = (container: StandaloneFuseki) => {
    const index = containers.indexOf(container);
    if (index >= 0) containers.splice(index, 1);
  };
  const removeContainer = async (container: StandaloneFuseki) => {
    await container.remove();
    unregisterContainer(container);
  };
  return {
    get containers() {
      return [...containers];
    },
    get volumes() {
      return [...volumes];
    },
    registerContainer(container) {
      if (!containers.includes(container)) containers.push(container);
    },
    registerVolume(name) {
      if (!volumes.includes(name)) volumes.push(name);
    },
    unregisterVolume(name) {
      const index = volumes.indexOf(name);
      if (index >= 0) volumes.splice(index, 1);
    },
    removeContainer,
    containerCleanupActions() {
      return containers.map((container) => ({
        resource: `Fuseki container ${container.name}`,
        run: () => removeContainer(container),
      }));
    },
    volumeCleanupActions(removeVolume) {
      return volumes.map((name) => ({
        resource: `graph volume ${name}`,
        run: () => removeVolume(name),
      }));
    },
  };
}

export async function attemptRestoreCleanup(
  actions: readonly RestoreCleanupAction[],
): Promise<RestoreCleanupFailure[]> {
  const failures: RestoreCleanupFailure[] = [];
  for (const action of actions) {
    try {
      await action.run();
    } catch (error) {
      failures.push({ action, error });
    }
  }
  return failures;
}

function restoreCleanupError(
  failures: readonly RestoreCleanupFailure[],
  message: string,
): AggregateError {
  return new AggregateError(
    failures.map(
      ({ action, error }) => new Error(`${action.resource} cleanup failed`, { cause: error }),
    ),
    message,
  );
}

export function createRestoreCopyDisposal(
  actions: readonly RestoreCleanupAction[],
): () => Promise<void> {
  const completed = new Set<RestoreCleanupAction>();
  let active: Promise<void> | undefined;
  return () => {
    if (active) return active;
    const run = async () => {
      const pending = actions.filter((action) => !completed.has(action));
      const failures = await attemptRestoreCleanup(pending);
      const failed = new Set(failures.map(({ action }) => action));
      for (const action of pending) if (!failed.has(action)) completed.add(action);
      if (failures.length) throw restoreCleanupError(failures, 'restore copy disposal failed');
    };
    active = run().finally(() => {
      active = undefined;
    });
    return active;
  };
}

/** Physical paths belong to the isolated copy; ciphertext and proof identities
 * remain exactly those bound by the retained source manifest. */
export function rebindRetainedRecoveryAttachment<T>(attachment: EncryptedRecoveryAttachment<T>, directory: string): EncryptedRecoveryAttachment<T> {
  const path = join(directory, basename(attachment.path));
  const ciphertext = readFileSync(path);
  if (hash(ciphertext) !== attachment.ciphertextDigest || String(ciphertext.length) !== attachment.ciphertextBytes)
    throw new Error('copied recovery attachment differs from retained ciphertext');
  return { ...attachment, path };
}

/** One real owner/native cut, one physical backup, isolated writable replay copies. */
async function runOwnerRestoreErasureFixture(options: OwnerRestoreErasureFixtureOptions = {}, retained?: { context: SourceContext; manifest: RetainedSourceManifest<RetainedOwnerState> }) {
  const preparationStarted = Date.now();
  const { runId, artifacts } = requireFaultTier();
  const timing = createRestoreFixtureTiming({ artifactDirectory: artifacts });
  const root = resolve(import.meta.dir, '../../..');
  const qa = qaStack(runId);
  const image = pinnedImage();
  const apps = readEnv(join(qa.directory, 'apps.env'));
  const databases = retained ? {
    urls: { ...retained.manifest.metadata.databaseUrls as unknown as Record<'account' | 'access' | 'content' | 'relay', string> },
    close: async () => {},
    snapshot: async () => { throw new Error('retained consumers cannot snapshot former source databases'); },
  } : await timing.phase('source.owner-database-clone', () =>
    cloneQaOwnerDatabases(runId, ['account', 'access', 'content', 'relay'], 'owner'),
  );
  const suffix = randomBytes(6).toString('hex');
  const directory = join(root, '.temp', `owner-erasure-restore-${suffix}`);
  const socketDirectory = join(root, '.temp', 's');
  const backupObjects = retained ? join(retained.context.backup, 'objects-cut') : join(directory, 'objects-cut');
  const pgBackup = retained ? join(retained.context.backup, 'postgres-cut') : join(directory, 'postgres-cut');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const pools = new Set<Pool>();
  const pool = (url: string) => {
    const value = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2_000 });
    pools.add(value);
    return value;
  };
  const closePool = async (value: Pool) => {
    await value.end();
    pools.delete(value);
  };
  const source = {
    account: pool(databases.urls.account),
    access: pool(databases.urls.access),
    content: pool(databases.urls.content),
    relay: pool(databases.urls.relay),
  };
  const graphResources = createRestoreGraphResourceOwner();
  const copies: string[] = [],
    pgCopies: string[] = [];
  const candidateDirectories = new Set<string>();
  const docker = (args: string[], timeout = 60_000) => {
    const result = spawnSync('docker', args, { env: qa.dockerEnv, encoding: 'utf8', timeout });
    if (result.status !== 0 || result.error)
      throw new Error(`isolated recovery Docker step failed: ${result.stderr.slice(-1500)}`);
    return result.stdout.trim();
  };
  const volume = (label: string) => {
    const name = `rezics-owner-erasure-${suffix}-${label}`;
    graphResources.registerVolume(name);
    docker(['volume', 'create', name]);
    return name;
  };
  const removeContainer = (container: StandaloneFuseki) =>
    graphResources.removeContainer(container);
  const removeVolume = (name: string) => {
    let removeFailure: unknown;
    try {
      docker(['volume', 'rm', '-f', name], 30_000);
    } catch (error) {
      removeFailure = error;
    }
    const remaining = docker(['volume', 'ls', '--quiet', '--filter', `name=${name}`])
      .split(/\s+/)
      .filter((value) => value === name);
    if (remaining.length) {
      throw removeFailure ?? new Error(`Docker volume ${name} remains after removal`);
    }
    graphResources.unregisterVolume(name);
  };
  const copyGraph = (from: string, to: string) => copyVolume(from, to, qa.dockerEnv);
  let retainedPort: number | undefined;
  const admin = async (sql: string) => {
    const client = new Client({
      connectionString: `postgres://postgres:${encodeURIComponent(qa.composeEnv.POSTGRES_PASSWORD!)}@127.0.0.1:${retainedPort ?? qa.composeEnv.POSTGRES_PORT}/postgres`,
    });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  const pgCtlStatus = (data: string) => {
    if (!existsSync(data)) return 'stopped' as const;
    const result = spawnSync('pg_ctl', ['-D', data, 'status'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.error) throw result.error;
    if (result.status === 0) return 'running' as const;
    if (result.status === 3) return 'stopped' as const;
    if (result.status === 4 && !existsSync(join(data, 'postmaster.pid'))) return 'stopped' as const;
    throw new Error(
      `could not confirm PostgreSQL state for ${data}: ${result.stderr || result.stdout || result.status}`,
    );
  };
  const stopPostgres = (data: string) => {
    if (pgCtlStatus(data) === 'running') {
      execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-t', '10', '-w', 'stop'], {
        timeout: 15_000,
      });
    }
    if (pgCtlStatus(data) !== 'stopped')
      throw new Error(`PostgreSQL at ${data} is still running after stop`);
  };
  const removeCandidateDirectory = (path: string) => {
    if (pgCopies.includes(path) && pgCtlStatus(path) !== 'stopped')
      throw new Error(`PostgreSQL directory ${path} is not safe to remove while running`);
    rmSync(path, { recursive: true, force: true });
    if (existsSync(path)) throw new Error(`candidate directory ${path} remains after removal`);
    candidateDirectories.delete(path);
    const pgIndex = pgCopies.indexOf(path);
    if (pgIndex >= 0) pgCopies.splice(pgIndex, 1);
  };
  const objects = new DirectoryObjects(join(directory, 'objects-live'));
  let attachmentCustody: ReturnType<typeof recoveryTestCustody> | undefined;
  let authenticated: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  const close = () =>
    timing.phase('fixture.final-disposal', async () => {
      const actions: RestoreCleanupAction[] = [];
      if (attachmentCustody)
        actions.push({
          resource: 'native Access attachment key custody',
          run: () => closeRecoveryTestCustody(attachmentCustody!),
        });
      if (authenticated)
        actions.push({
          resource: 'authenticated fixture client',
          run: () => authenticated!.close(),
        });
      for (const value of [...pools])
        actions.push({ resource: 'candidate or source pool', run: () => closePool(value) });
      actions.push(...graphResources.containerCleanupActions());
      const sourceData = join(directory, 'postgres-source');
      for (const data of pgCopies.filter(data => data !== sourceData))
        actions.push({
          resource: `recovery PostgreSQL process ${data}`,
          run: () => stopPostgres(data),
        });
      for (const name of [...copies].reverse())
        actions.push({
          resource: `retained relay database ${name}`,
          run: async () => {
            if (!/^[a-z0-9_]+$/.test(name)) throw new Error('invalid retained relay database name');
            await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
            const index = copies.indexOf(name);
            if (index >= 0) copies.splice(index, 1);
          },
        });
      actions.push({
        resource: 'source and relay template databases',
        run: () => databases.close(),
      });
      if (pgCopies.includes(sourceData)) actions.push({
        resource: 'isolated current source PostgreSQL process', run: () => stopPostgres(sourceData),
      });
      actions.push(...graphResources.volumeCleanupActions(removeVolume));
      for (const path of [...candidateDirectories]) {
        actions.push({
          resource: `candidate directory ${path}`,
          run: () => removeCandidateDirectory(path),
        });
      }
      const failures = await attemptRestoreCleanup(actions);
      const hasOutstandingResources =
        pools.size > 0 ||
        graphResources.containers.length > 0 ||
        pgCopies.length > 0 ||
        copies.length > 0 ||
        graphResources.volumes.length > 0 ||
        candidateDirectories.size > 0;
      if (!hasOutstandingResources) {
        try {
          rmSync(directory, { recursive: true, force: true });
          if (existsSync(directory)) throw new Error('fixture directory remains after removal');
        } catch (error) {
          failures.push({
            action: { resource: `fixture directory ${directory}`, run: () => undefined },
            error,
          });
        }
      } else {
        failures.push({
          action: { resource: `fixture directory ${directory}`, run: () => undefined },
          error: new Error('retained because candidate resources remain outstanding'),
        });
      }
      if (failures.length)
        throw restoreCleanupError(failures, 'restore fixture final disposal failed');
    });
  let sourceApiPhase: RestoreFixturePhaseHandle | undefined;
  let sourceProofPhase: RestoreFixturePhaseHandle | undefined;
  try {
    const produce = async () => {
    let nativeAccessAttachment: EncryptedRecoveryAttachment<AccessErasureRecoverySummary> | undefined;
    let beforeCutApiSeedResult: RetainedJson = null;
    await timing.phase('source.content-migration', () => migrateContent(source.content));
    expect(
      (await source.content.query("SELECT to_regclass('content.receipt') IS NOT NULL AS present"))
        .rows,
    ).toEqual([{ present: true }]);
    const liveVolume = volume('live'),
      cutVolume = volume('cut');
    const live = await timing.phase('source.first-fuseki-readiness', () =>
      standaloneFuseki(
        qa.dockerEnv,
        {
          name: `rezics-owner-erasure-${suffix}-live`,
          image: image,
          volume: liveVolume,
          secrets: fusekiSecrets(qa.composeEnv),
        },
        { onAllocated: graphResources.registerContainer },
      ),
    );
    const native = new FusekiClient(
      live.url,
      qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN,
      qa.composeEnv.FUSEKI_COMMAND_TOKEN,
    );
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    sourceApiPhase = timing.begin('source.actual-api-fixture-work');
    await initializeFreshGraph(native, lineage);
    authenticated = await ratingAccount(
      { ...apps, ACCOUNT_DATABASE_URL: databases.urls.account },
      options.laterApiAdmission
        ? 'openid work:create work:edit work:read owner:operate access:manage'
        : 'openid work:create work:edit work:read owner:operate',
    );
    const refreshTime = (token: string) => {
      const { exp } = decodeJwt(token);
      if (!Number.isSafeInteger(exp)) throw new Error('actual OAuth token expiry is unavailable');
      return exp! * 1_000 - 30_000;
    };
    let ownerToken = authenticated.tokenA;
    let ownerTokenRefreshAt = refreshTime(ownerToken);
    const currentOwnerToken = async () => {
      // Decoded expiry schedules refresh only. The actual Account verifier
      // authenticates and introspects every request in the Owner route.
      if (Date.now() >= ownerTokenRefreshAt) {
        ownerToken = await authenticated!.tokenFor(authenticated!.a);
        ownerTokenRefreshAt = refreshTime(ownerToken);
      }
      return ownerToken;
    };
    const actor = `https://rezics.com/id/${randomUUID()}`,
      principalId = randomUUID();
    const principal = await authenticated.verifier.verify(
      new Request('http://main.local', {
        headers: { authorization: `Bearer ${authenticated.tokenA}` },
      }),
      ['work:edit'],
    );
    await source.access.query(
      'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES($1,$2,$3)',
      [principalId, principal.issuer, principal.subject],
    );
    await source.access.query("INSERT INTO access.authority_subject(id,kind) VALUES($1,'agent')", [
      actor,
    ]);
    let registry = new AccessAdmissionRegistry(
      source.access,
      qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY,
    );
    const grant = async (scope: string, action: string): Promise<void> => { await grantFixtureAuthority(source.access, {
      scope,
      requireDispatch: false,
      representations: [{ principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' },
    }); };
    await grant('work:create:root', 'work.create');
    const createCustody = () =>
      new ReceiptCustody(
        new PostgresReceiptCustodyStore(source.access),
        objects,
        native,
        qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
        proofRetirementSender(live.url, qa.composeEnv.FUSEKI_COMMAND_TOKEN!),
      );
    let custody = createCustody();
    const env: WorkActivationEnvironment = {
      fuseki: native,
      lineage,
      objectDirectory: objects.directory,
      workObjects: objects,
      receiptCustody: custody,
      titleAdmissionKey: qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY,
    };
    await ensureModelGeneration(env);
    const created = await createAdmittedMetadataWork(
      env,
      authenticated.verifier,
      registry,
      new Request('http://main.local/v1/works', {
        headers: { authorization: `Bearer ${authenticated.tokenA}` },
      }),
      {
        title: 'Owner restore erasure fixture',
        language: 'en',
        actingSubject: actor,
        idempotencyKey: randomUUID(),
      },
    );
    await grant(`work:edit:${created.work}`, 'work.edit');
    const metadata = async (intent: MetadataIntent) => {
      const registered = await registry.register({
        principal,
        actingSubject: actor,
        scope: `work:edit:${created.work}`,
        action: 'work.edit',
        idempotencyKey: randomUUID(),
        requestDigest: metadataDigest(intent),
      });
      const claimed = await registry.claim(registered.id, registered.requestDigest, principal);
      expect(await commitMetadata(env, claimed, intent)).toBe(true);
      const terminal = await readMetadataReceipt(env, claimed.id);
      if (!terminal || terminal.outcome !== 'succeeded')
        throw new Error('Native metadata did not produce its successful terminal');
      await registry.recordGraphOutcome(claimed.id, terminal);
      return terminal;
    };
    await metadata({
      work: created.work,
      expectedHead: null,
      state: checkedMetadataState({
        kind: 'header',
        originalTitle: { value: 'Owner restore erasure fixture', language: 'en' },
        localized: [],
      }),
    });
    const core = new ContentCore(source.content);
    const save = async (body: string) => {
      const saved = await core.saveDraft({
        operationId: randomUUID(),
        variant: {
          id: `urn:rezics:variant:${randomUUID()}`,
          resourceId: created.work,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' },
          direction: 'ltr',
        },
        expectedHead: null,
        model: 'content-shape-v1',
        sourceRevision: null,
        provenance: { fixture: 'owner-restore-erasure' },
        serializedJson: JSON.stringify({ body }),
      });
      if (saved.outcome !== 'succeeded' || !saved.revisionId)
        throw new Error('Content fixture save failed');
      return saved.revisionId;
    };
    // Reuse C6's stopped disposable source cut: subsequent positions are
    // allocated by real native commands, with diagnostic and Main cuts unequal.
    // Reset before publication so its retained approval stream survives.
    live.runner.stop();
    live.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/owner-erasure-source.ru <<'OWNER_ERASURE_SOURCE'
PREFIX rv: <https://rezics.com/vocab/>
CLEAR GRAPH <urn:rezics:graph:outbox> ;
DELETE { GRAPH <urn:rezics:graph:control> {
  <urn:rezics:dataset:product> rv:sequence ?old . <${MAIN_RELAY_STREAM_SCOPE}> ?p ?o } }
INSERT { GRAPH <urn:rezics:graph:control> {
  <urn:rezics:dataset:product> rv:sequence 896 .
  <${MAIN_RELAY_STREAM_SCOPE}> rv:dataEpoch "${lineage.dataEpoch}" ; rv:streamSequence 0 ; rv:legacyThroughSequence 0 } }
WHERE { GRAPH <urn:rezics:graph:control> {
  <urn:rezics:dataset:product> rv:sequence ?old . OPTIONAL { <${MAIN_RELAY_STREAM_SCOPE}> ?p ?o } } }
OWNER_ERASURE_SOURCE
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/owner-erasure-source.ru`);
    await live.runner.start();
    const published = await seedContent(
      env,
      source.content,
      source.access,
      created.work,
      'erased native HTTP fixture payload',
    );
    const consumer = `owner-erasure-restore:${suffix}`;
    await initializeRelayCheckpoint(source.relay, consumer, lineage.dataEpoch);
    const drain = async (relay: Pool, relayConsumer = consumer) => {
      for (let batch = 0; batch < 32; batch++) {
        if (!(await relayMainOutboxOnce(native, relay, relayConsumer, { ownerOutbox: custody })))
          return;
      }
      throw new Error('fixture relay handoff exceeded its bound');
    };
    const revisionId = published.revisionId;
    const cursor = new ContentProjectionCursor(source.content);
    const projectionConsumer = `owner-erasure-${suffix}`;
    await cursor.initialize(projectionConsumer);
    await drain(source.relay);
    for (let page = 0; page < 32; page++) {
      if (!(await deliverRetainedContentEligibilityOnce(env, core, source.relay, consumer))) break;
      if (page === 31) throw new Error('fixture eligibility handoff exceeded its bound');
    }
    const high = await core.ownerPosition();
    for (
      let event = 0;
      event < 32 && (await cursor.read(projectionConsumer)).sequence !== high.sequence;
      event++
    ) {
      if (!(await relayContentProjectionOnce(env, core, cursor, projectionConsumer))) {
        throw new Error('actual Content projection ended before its owner cut');
      }
    }
    expect((await cursor.read(projectionConsumer)).sequence).toBe(high.sequence);
    expect(
      (
        await native.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      VALUES ?reference { rv:revision rv:contentRevision }
      GRAPH <urn:rezics:search:public> { ?unit ?reference <urn:rezics:content:revision:${revisionId}> }
    }`)
      ).boolean,
    ).toBe(true);
    const laterRevisionId = await save('later retained journal fixture payload');
    const component = `https://rezics.com/id/${randomUUID()}`;
    const edition = (title: string) =>
      checkedMetadataState({
        kind: 'edition',
        id: component,
        status: 'active',
        title: { value: title, language: 'en' },
        contentLanguage: 'en',
        editionStatement: null,
        publisher: null,
        publicationYear: null,
        isbn13: null,
      });
    const command = await metadata({
      work: created.work,
      expectedHead: null,
      state: edition('Retained native edition 1'),
    });
    const second = await metadata({
      work: created.work,
      expectedHead: command.revision!,
      state: edition('Retained native edition 2'),
    });
    const third = await metadata({
      work: created.work,
      expectedHead: second.revision!,
      state: edition('Retained native edition 3'),
    });
    for (const receipt of [command.receipt, second.receipt, third.receipt])
      await custody.retire(receipt);
    const retired = (
      await source.access.query<{
        payload_sha256: string;
        payload: Buffer;
        retired: boolean;
        data_epoch: string;
        stream_sequence: string;
      }>(
        'SELECT payload_sha256,payload,retired_at IS NOT NULL AS retired,data_epoch,stream_sequence::text FROM access.command_custody WHERE receipt=$1',
        [command.receipt],
      )
    ).rows[0]!;
    const prepared = JSON.parse(retired.payload.toString('utf8')) as PreparedCommand;
    const historicalManifest = prepared.manifest.slice(-64);
    const manifest = JSON.parse(
      readFileSync(join(objects.directory, historicalManifest), 'utf8'),
    ) as { payload: string };
    expect(retired.retired).toBe(true);
    expect(
      (
        await native.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:receipts> { <${command.receipt}> a rv:CommitProof } }`)
      ).boolean,
    ).toBe(false);
    let beforeCutMembershipProof: MembershipCompletionProof | undefined;
    if (options.beforeCutApiSeed) {
      await provisionFixtureAuthor(env, actor);
      env.structureGroupRoots = new StructureGroupRootStore(source.content, objects);
      env.structureQualifierRoots = new StructureQualifierRootStore(source.content, objects);
      const recipeWork: MainWorkDependencies = {
        environment: env,
        structureObjects: objects,
        account: authenticated.verifier,
        access: registry,
        content: core,
      };
      const request: RecipeApiRequest = createRecipeApiRequest(
        native,
        recipeWork,
        currentOwnerToken,
      );
      const seeded = await options.beforeCutApiSeed({ request, actor, grant });
      if (!isRetainedJson(seeded)) throw new Error('foreground source seed must return JSON proof identities');
      beforeCutApiSeedResult = seeded;
      const preparedMembership = await normalizeStoredMembership(env, 256, Date.now() + 540_000);
      if (!preparedMembership.complete) {
        throw new Error('Source Recipe membership preparation did not complete before capture');
      }
      beforeCutMembershipProof = await readMembershipCompletionProof(native);
      if (
        beforeCutMembershipProof?.dataEpoch !== lineage.dataEpoch ||
        beforeCutMembershipProof.revision !== 'ordered-membership-v1'
      ) {
        throw new Error(
          'Source Recipe membership preparation has no current native completion proof',
        );
      }
    }
    await drain(source.relay);
    await grant(`work:read:${created.work}`, 'work.read');
    const leaseTemplates = {
      download: (
        await new AccessDownloadLeases(source.access).admit(
          principal,
          actor,
          created.work,
          randomUUID(),
        )
      ).id,
      search: (
        await new ContentSearchReadAccess(source.access).admit(
          principal,
          actor,
          created.work,
          published.variantId,
        )
      ).id,
    };
    const availableBeforeErasure = (
      await new ContentCore(source.content).readExactBatch(
        [revisionId],
        async (ids) => new Set(ids),
      )
    )[0]!;
    expect(availableBeforeErasure.status).toBe('available');
    if (availableBeforeErasure.status !== 'available')
      throw new Error('source publication bytes are unavailable before erasure');
    expect(hash(availableBeforeErasure.serializedJson)).toBe(
      availableBeforeErasure.reference.byteDigest,
    );
    expect(Buffer.byteLength(availableBeforeErasure.serializedJson, 'utf8')).toBe(
      availableBeforeErasure.reference.byteLength,
    );
    expect(availableBeforeErasure.serializedJson).toContain('erased native HTTP fixture payload');
    // The quote is part of the signed original cut: the cited revision's own
    // text, before the recovery fence, coverage capture and physical backup.
    const cited = JSON.parse(availableBeforeErasure.serializedJson) as { body?: unknown };
    if (
      typeof cited.body !== 'string' ||
      cited.body.includes('\n') ||
      !cited.body.includes('erased native HTTP fixture payload')
    ) {
      throw new Error('cited revision is not one quotable paragraph of the published source');
    }
    const quotedExact = cited.body;
    const quotedBody = 'authored annotation stays';
    const quotedInput = {
      revisionId,
      resourceId: created.work,
      author: actor,
      exact: quotedExact,
      body: quotedBody,
    };
    const quoted = await new ContentComments(source.content).create({
      ...quotedInput,
      admissionId: randomUUID(),
      authorityEpoch: '1',
      scope: `content:comment:${created.work}`,
      requestDigest: contentCommentIntentDigest(quotedInput),
    });
    if (!('selector' in quoted.target) || quoted.target.selector.exact !== quotedExact) {
      throw new Error('comment core did not quote the cited revision');
    }
    const claim = `https://rezics.com/id/${randomUUID()}`;
    const claimRevision = `https://rezics.com/id/${randomUUID()}`;
    await new VerificationStore(source.content).recordEvidence(
      principalId,
      `quote:${randomUUID()}`,
      claim,
      {
        claimRevision,
        expectedHead: null,
        items: [
          {
            stance: 'supports',
            contentRevision: revisionId,
            selector: { exact: quotedExact, start: 0, end: quotedExact.length },
            availability: 'available',
          },
        ],
      },
    );
    const evidence = (
      await source.content.query<{ id: string; manifest_digest: string; request_digest: string }>(
        `SELECT e.id::text AS id, e.manifest_digest, r.request_digest
        FROM verification.evidence_set_revision e
        JOIN verification.receipt r ON r.id = e.operation_id
        WHERE e.claim = $1`,
        [claim],
      )
    ).rows[0];
    if (!evidence) throw new Error('cited evidence receipt is unavailable');
    const quotedCommentId = quoted.comment.split('/').at(-1)!;
    const quotedSource = {
      commentId: quotedCommentId,
      revisionId,
      exact: quotedExact,
      body: quotedBody,
      prefix: quoted.target.selector.prefix,
      suffix: quoted.target.selector.suffix,
      evidenceRevisionId: evidence.id,
      manifestDigest: evidence.manifest_digest,
      requestDigest: evidence.request_digest,
      start: 0,
      end: quotedExact.length,
    };
    await drain(source.relay);
    if (options.laterApiAdmission) {
      await grant(`erasure:${created.work}`, 'erasure.request');
    }
    const generation = await engageAccessRecoveryFence(source.access);
    const baseAccountRows = options.laterApiAdmission ? await accountRows(source.account) : undefined;
    let coverage: RecoveryCoverage | undefined;
    await timing.phase('source.recovery-authority-capture', async () => {
      for (let attempt = 0; attempt < 8 && !coverage; attempt++) {
        try {
          coverage = await captureGraphRecoveryCoverage(
            native,
            source.account,
            source.access,
            source.relay,
            consumer,
            source.content,
            {
              directory: objects.directory,
              workObjects: objects,
              structureObjects: objects,
            },
          );
        } catch (error) {
          if (
            !(error instanceof RestoreLineageConflict) ||
            !error.message.includes('Account WAL frontier') ||
            attempt === 7
          )
            throw error;
          await Bun.sleep(100);
        }
      }
    });
    if (!coverage?.objects) throw new Error('fixture signed owner coverage is unavailable');
    const baseCoverage = coverage;
    const authority = {
      sealedCoverage: JSON.stringify(
        sealRecoveryPayload(coverage, restoreKey, 'graph-recovery-coverage'),
      ),
      hmacKey: restoreKey,
    };
    await retainRecoveryCoverageHead(source.relay, authority.sealedCoverage, restoreKey);
    await retainErasureCoverage(source.relay, consumer);
    // Retaining the first signed capture advances the real cluster WAL while
    // the quiesced owner rows and graph cut remain unchanged. Capture the
    // second frontier before erasure makes historical Content unavailable.
    let newerCoverage = await timing.phase('source.newer-authority-capture', () =>
      captureGraphRecoveryCoverage(
        native,
        source.account,
        source.access,
        source.relay,
        consumer,
        source.content,
        {
          directory: objects.directory,
          workObjects: objects,
          structureObjects: objects,
        },
      ),
    );
    const { accountPg: capturedPg, ...capturedOwners } = coverage;
    const { accountPg: newerPg, ...newerOwners } = newerCoverage;
    expect(newerOwners).toEqual(capturedOwners);
    expect(newerPg.systemIdentifier).toBe(capturedPg.systemIdentifier);
    expect(
      (
        await source.account.query('SELECT $2::pg_lsn > $1::pg_lsn AS advanced', [
          capturedPg.flushedLsn,
          newerPg.flushedLsn,
        ])
      ).rows,
    ).toEqual([{ advanced: true }]);
    let newerAuthority = {
      sealedCoverage: JSON.stringify(
        sealRecoveryPayload(newerCoverage, restoreKey, 'graph-recovery-coverage'),
      ),
      hmacKey: restoreKey,
    };
    timing.finish(sourceApiPhase);
    sourceApiPhase = undefined;
    const rdfCut = await native.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
    await timing.phase('source.cut-stop-copy-restart', async () => {
      cpSync(objects.directory, backupObjects, { recursive: true });
      live.runner.stop();
      await copyGraph(liveVolume, cutVolume);
      await live.runner.start();
    });
    // Reuse the owner-cut drill's physical backup mechanism. The graph cut is
    // copied separately, so its original live graph can produce genuine later proof.
    const remote = `/tmp/rezics-owner-erasure-${suffix}`;
    const postgresRecoveryMaxLocks = await timing.phase('source.pg-basebackup-export-verification', async () => {
      // Command-line settings are absent from the backup's configuration, but WAL
      // recovery requires at least the primary's lock-table capacity in every copy.
      const { rows } = await source.account.query<{ maxLocks: number }>(
        `SELECT current_setting('max_locks_per_transaction')::integer AS "maxLocks"`,
      );
      const maxLocks = rows[0]?.maxLocks;
      if (typeof maxLocks !== 'number' || !Number.isSafeInteger(maxLocks) || maxLocks < 1)
        throw new Error('physical fixture backup has no valid PostgreSQL recovery lock capacity');
      try {
        const copied = qa.compose(
          [
            'exec',
            '-T',
            '-u',
            'postgres',
            'postgres',
            'sh',
            '-ec',
            `PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -p 5432 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast`,
          ],
          65_000,
        );
        if (copied.status !== 0)
          throw new Error(`physical fixture backup failed: ${copied.output.slice(-2000)}`);
        const container = qa.compose(['ps', '-q', 'postgres']).output.trim();
        if (!/^[0-9a-f]{12,64}$/.test(container))
          throw new Error('QA PostgreSQL container is unavailable');
        docker(['cp', `${container}:${remote}`, pgBackup]);
        execFileSync('pg_verifybackup', ['--no-parse-wal', pgBackup], { timeout: 15_000 });
      } finally {
        const removed = qa.compose(
          ['exec', '-T', '-u', 'postgres', 'postgres', 'rm', '-rf', remote],
          10_000,
        );
        if (removed.status !== 0) throw new Error('physical fixture backup cleanup failed');
      }
      return maxLocks;
    });
    sourceProofPhase = timing.begin('source.erasure-proof-and-retained-authority');
    let laterAdmission: LaterAdmissionEvidence | undefined;
    let erased: Awaited<ReturnType<typeof journalErasure>>;
    let original: Awaited<ReturnType<typeof readGraphErasureProof>>;
    if (options.laterApiAdmission) {
      // Retain the exact C0 rows for the owner's delta scan; the physical backup stays untouched.
      const baseAccess = pool(await databases.snapshot('access', () => closePool(source.access)));
      source.access = pool(databases.urls.access);
      const baseRelay = pool(await databases.snapshot('relay', () => closePool(source.relay)));
      source.relay = pool(databases.urls.relay);
      registry = new AccessAdmissionRegistry(
        source.access,
        qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY,
      );
      custody = createCustody();
      env.receiptCustody = custody;
      attachmentCustody = recoveryTestCustody(join(directory, 'native-access-custody'), suffix);
      await releaseAccessRecoveryFence(source.access, generation);
      const idempotencyKey = `later-erasure-${randomUUID()}`;
      const erasureApp = new Elysia().use(
        erasureRoutes({
          environment: env,
          account: authenticated.verifier,
          access: registry,
          erasures: new ErasureService(source.relay, source.content, source.access),
        }),
      );
      const response = await erasureApp.handle(
        new Request('http://main.local/v1/erasures', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await currentOwnerToken()}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            profile: 'content-revision-erasure-v1',
            actingSubject: actor,
            resourceId: created.work,
            revisionIds: [revisionId],
          }),
        }),
      );
      const apiReport = (await response.json().catch(() => undefined)) as
        | { erasureId: string; erasureEpoch: string; replayed: boolean }
        | undefined;
      if (
        response.status !== 200 ||
        !apiReport ||
        !/^[0-9a-f-]{36}$/.test(apiReport.erasureId) ||
        !/^[1-9][0-9]*$/.test(apiReport.erasureEpoch) ||
        apiReport.replayed
      ) {
        throw new Error(
          `later erasure API fixture returned ${response.status}: ${JSON.stringify(apiReport)}`,
        );
      }
      erased = {
        erasureId: apiReport.erasureId,
        erasureEpoch: apiReport.erasureEpoch,
        replayed: apiReport.replayed,
      };
      await drain(source.relay);
      const currentGeneration = await engageAccessRecoveryFence(source.access);
      if (BigInt(currentGeneration) !== BigInt(generation) + 2n) {
        throw new Error('later erasure API fixture did not reopen and refence source Access once');
      }
      const admissionId = (
        await source.relay.query<{ admission_id: string | null }>(
          'SELECT admission_id FROM relay.erasure WHERE id=$1',
          [erased.erasureId],
        )
      ).rows[0]?.admission_id;
      if (!admissionId) throw new Error('later erasure API fixture has no native admission link');
      const admitted = (
        await source.access.query<{
          state: string;
          action: string;
          scope_id: string;
          graph_outcome: string;
        }>(`SELECT state, action, scope_id, graph_outcome FROM access.admission WHERE id=$1`, [
          admissionId,
        ])
      ).rows[0];
      if (
        admitted?.state !== 'sealed' ||
        admitted.action !== 'erasure.request' ||
        admitted.scope_id !== `erasure:${created.work}` ||
        admitted.graph_outcome !== 'succeeded'
      ) {
        throw new Error('later erasure API fixture did not leave a completed native admission');
      }
      const accountChanges = changedAccountRows(baseAccountRows!, await accountRows(source.account));
      console.info('later-admission C0/C1 Account row changes', accountChanges);
      // An unreviewed change must stop before current attachment publication.
      expectReviewedAccountUsageChanges(accountChanges);
      const captureRelay = await source.relay.connect();
      try {
        await captureRelay.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await captureRelay.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))",
        );
        newerCoverage = await timing.phase('source.later-authority-capture', () =>
          captureGraphRecoveryCoverage(
            native,
            source.account,
            source.access,
            source.relay,
            consumer,
            source.content,
            {
              directory: objects.directory,
              workObjects: objects,
              structureObjects: objects,
            },
            { fuseki: native, relayClient: captureRelay },
            {
              baseCoverage,
              baseCoverageEnvelope: authority.sealedCoverage,
              baseCoverageHmacKey: restoreKey,
              baseAccessPool: baseAccess,
              baseRelayPool: baseRelay,
              encryptAttachment: async (produce) => {
                nativeAccessAttachment = await encryptRecoveryAttachment(
                  attachmentCustody!.recipient,
                  join(directory, 'native-access-attachments'),
                  produce,
                  attachmentCustody!.publicOnly,
                );
                return nativeAccessAttachment;
              },
            },
          ),
        );
        await captureRelay.query('COMMIT');
      } catch (error) {
        await captureRelay.query('ROLLBACK');
        throw error;
      } finally {
        captureRelay.release();
      }
      newerAuthority = {
        sealedCoverage: JSON.stringify(
          sealRecoveryPayload(newerCoverage, restoreKey, 'graph-recovery-coverage'),
        ),
        hmacKey: restoreKey,
      };
      await retainRecoveryCoverageHead(source.relay, newerAuthority.sealedCoverage, restoreKey, {
        attachmentDirectory: join(directory, 'native-access-attachments'),
      });
      const journalFrontier = await retainErasureCoverage(source.relay, consumer);
      if (journalFrontier !== erased.erasureEpoch) {
        throw new Error('later erasure API fixture did not retain its complete journal frontier');
      }
      original = await readGraphErasureProof(
        native,
        lineage,
        erased.erasureId,
        erased.erasureEpoch,
        [revisionId],
      );
      laterAdmission = {
        idempotencyKey,
        admissionId,
        erasureId: erased.erasureId,
        erasureEpoch: erased.erasureEpoch,
        baseGeneration: generation,
        currentGeneration,
        accountChanges,
      };
    } else {
      erased = await journalErasure(source.relay, {
        operationId: randomUUID(),
        requestDigest: hash(revisionId),
        kind: 'revision',
        principalId: principalId,
        admissionId: randomUUID(),
        authorityEpoch: generation,
        targets: [{ kind: 'content_revision', ref: revisionId }],
      });
      await suppressGraphContentRevisions(native, lineage, erased.erasureId, erased.erasureEpoch, [
        revisionId,
      ]);
      original = await readGraphErasureProof(
        native,
        lineage,
        erased.erasureId,
        erased.erasureEpoch,
        [revisionId],
      );
    }
    expect(original.sequence).toBe((BigInt(coverage.priorSequence) + 1n).toString());
    if (!options.laterApiAdmission) {
      await applyContentErasure(source.content, {
        erasureId: erased.erasureId,
        erasureEpoch: erased.erasureEpoch,
        resourceId: created.work,
        revisionIds: [revisionId],
        graphProof: original,
        preservationAccess: source.access,
      });
      await markErasureSuppressed(source.relay, erased.erasureId);
    }
    await drain(source.relay);
    const retainedProof = (
      await source.relay.query<{
        graph_position: object;
        relay_position: { streamScope: string; dataEpoch: string; sequence: string };
      }>(
        `SELECT envelope->'data'->'sourcePosition' AS graph_position,
         envelope->'data'->'relayPosition' AS relay_position FROM relay.delivered_event
       WHERE envelope->>'type'='com.rezics.erasure.graph-suppressed.v1'
         AND envelope->'data'->'receipt'->'systemProof'->>'erasureId'=$1`,
        [erased.erasureId],
      )
    ).rows;
    expect(retainedProof).toHaveLength(1);
    expect(retainedProof[0]!.graph_position).toEqual({
      datasetId: 'product',
      dataEpoch: original.dataEpoch,
      sequence: original.sequence,
    });
    expect(retainedProof[0]!.relay_position.streamScope).toBe(MAIN_RELAY_STREAM_SCOPE);
    expect(BigInt(retainedProof[0]!.relay_position.sequence)).toBe(
      BigInt(coverage.relay.sequence) + 1n,
    );
    expect(retainedProof[0]!.relay_position.dataEpoch).toBe(original.dataEpoch);
    expect(original.sequence).not.toBe(retainedProof[0]!.relay_position.sequence);
    expect(original.sequence).not.toBe(erased.erasureEpoch);
    const backupLabel = `content:backup:owner-erasure:${suffix}`;
    await ensureRetentionDomain(source.relay, {
      label: backupLabel,
      owner: 'content',
      store: 'postgresql',
      custody: 'backup',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    await recordErasureInventory(source.relay, erased.erasureId, {
      owners: ['content'],
      liveRetentionReason: 'Original physical cut remains retained after logical suppression',
    });
    const retainedRelayTemplate = await databases.snapshot('relay', () => closePool(source.relay));
    if (options.laterApiAdmission) source.relay = pool(databases.urls.relay);
    timing.finish(sourceProofPhase!);
    sourceProofPhase = undefined;
      return { lineage, beforeCutMembershipProof, beforeCutApiSeedResult, coverage, authority, newerCoverage, newerAuthority, generation, laterAdmission, nativeAccessAttachment, original, erased, revisionId, quotedSource, availableBeforeErasure, laterRevisionId, created, retired, backupLabel, historicalManifest, manifest, prepared, principal, actor, published, principalId, leaseTemplates, postgresRecoveryMaxLocks, retainedRelayTemplate, rdfCut, liveVolume, cutVolume, native, live, custody, currentOwnerToken };
    };
    type ProducedSource = Awaited<ReturnType<typeof produce>>;
    const restoreSource = async (): Promise<ProducedSource> => {
      const saved = JSON.parse(JSON.stringify(retained!.manifest.metadata.facts)) as ProducedSource;
      const secrets = retained!.manifest.metadata.secrets as unknown as Record<string, string>;
      Object.assign(qa.composeEnv, secrets);
      const data = join(directory, 'postgres-source'), logFile = join(directory, 'postgres-source.log');
      pgCopies.push(data);
      candidateDirectories.add(data); candidateDirectories.add(logFile);
      await timing.phase('retained.source-postgres-copy-startup', async () => {
        copyRecoveryTree(join(retained!.context.backup, 'postgres-current'), data);
        appendFileSync(join(data, 'postgresql.auto.conf'), "\narchive_mode = off\nrestore_command = 'false'\n");
        writeFileSync(join(data, 'recovery.signal'), '');
        retainedPort = await freePort();
        execFileSync('pg_ctl', ['-D', data, '-l', logFile, '-o',
          `-h 127.0.0.1 -p ${retainedPort} -k ${socketDirectory} -c max_locks_per_transaction=${saved.postgresRecoveryMaxLocks}`,
          '-t', '60', '-w', 'start'], { timeout: 65_000 });
        for (const owner of ['account', 'access', 'content', 'relay'] as const) {
          await closePool(source[owner]);
          const url = new URL(databases.urls[owner]);
          url.hostname = '127.0.0.1'; url.port = String(retainedPort);
          databases.urls[owner] = url.toString();
          source[owner] = pool(url.toString());
        }
        let recovering = true;
        for (let attempt = 0; attempt < 100 && recovering; attempt++) {
          recovering = (await source.account.query<{ recovering: boolean }>('SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering ?? true;
          if (recovering) await Bun.sleep(100);
        }
        expect(recovering).toBe(false);
      });
      const liveVolume = volume('source-current');
      await copyGraph(retainedSourceVolumes(retained!.context.key).current, liveVolume);
      const cutVolume = retainedSourceVolumes(retained!.context.key).cut;
      const live = await timing.phase('retained.source-graph-readiness', () => standaloneFuseki(qa.dockerEnv, {
        name: `rezics-owner-erasure-${suffix}-source`, image, volume: liveVolume, secrets: fusekiSecrets(qa.composeEnv),
      }, { onAllocated: graphResources.registerContainer }));
      const native = new FusekiClient(live.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);
      cpSync(join(retained!.context.backup, 'objects-current'), objects.directory, { recursive: true });
      authenticated = await restoreRatingAccount(retained!.manifest.metadata.auth as unknown as RetainedRatingAuth, databases.urls.account);
      let token = authenticated.tokenA;
      const currentOwnerToken = async () => {
        if ((decodeJwt(token).exp ?? 0) * 1000 - 30_000 <= Date.now()) token = await authenticated!.tokenFor(authenticated!.a);
        return token;
      };
      const custody = new ReceiptCustody(new PostgresReceiptCustodyStore(source.access), objects, native,
        qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!, proofRetirementSender(live.url, qa.composeEnv.FUSEKI_COMMAND_TOKEN!));
      if (saved.nativeAccessAttachment) {
        const home = join(directory, 'native-access-custody');
        const secretHome = join(home, 'offhost-keys'), publicHome = join(home, 'backup-public-keys');
        mkdirSync(secretHome, { recursive: true, mode: 0o700 }); mkdirSync(publicHome, { recursive: true, mode: 0o700 });
        attachmentCustody = { recipient: retained!.manifest.metadata.attachmentRecipient as string,
          offhost: { ...process.env, GNUPGHOME: secretHome }, publicOnly: { ...process.env, GNUPGHOME: publicHome } };
        execFileSync('gpg', ['--batch', '--import', join(retained!.context.backup, 'attachment-secret.gpg')], { env: attachmentCustody.offhost, timeout: 60_000 });
        execFileSync('gpg', ['--batch', '--import', join(retained!.context.backup, 'attachment-public.gpg')], { env: attachmentCustody.publicOnly, timeout: 60_000 });
        cpSync(join(retained!.context.backup, 'native-access-attachments'), join(directory, 'native-access-attachments'), { recursive: true });
        saved.nativeAccessAttachment = rebindRetainedRecoveryAttachment(saved.nativeAccessAttachment,
          join(directory, 'native-access-attachments'));
      }
      // Buffer's JSON encoding is data, not a live custody process.
      const retiredPayload = saved.retired.payload as unknown as { type: string; data: number[] };
      saved.retired.payload = Buffer.from(retiredPayload.data);
      const relayUrl = new URL(saved.retainedRelayTemplate);
      relayUrl.hostname = '127.0.0.1'; relayUrl.port = String(retainedPort);
      return { ...saved, retainedRelayTemplate: relayUrl.toString(), liveVolume, cutVolume, native, live, custody, currentOwnerToken };
    };
    const state = retained ? await restoreSource() : await produce();
    const { lineage, beforeCutMembershipProof, beforeCutApiSeedResult, coverage, authority, newerCoverage, newerAuthority, generation, laterAdmission, nativeAccessAttachment, original, erased, revisionId, quotedSource, availableBeforeErasure, laterRevisionId, created, retired, backupLabel, historicalManifest, manifest, prepared, principal, actor, published, principalId, leaseTemplates, postgresRecoveryMaxLocks, retainedRelayTemplate, rdfCut, liveVolume, cutVolume, native, live, custody, currentOwnerToken } = state;
    let index = 0;
    const copy = async () => {
      if (retained) {
        const verified = await new RetainedSources().select(ownerErasureSourceAdapter(options));
        if (verified.digest !== retained.manifest.digest)
          throw new RetainedSourceRefusal(retained.context.key, ['source manifest changed during consumption']);
      }
      const copyStarted = Date.now(),
        ordinal = ++index;
      const retainedDatabase = `qa_owner_erasure_${suffix}_${ordinal}`;
      const relayTemplate = new URL(retainedRelayTemplate).pathname.slice(1);
      const { retainedRelay, relayUrl } = await timing.phase(
        'candidate.retained-relay-clone',
        async () => {
          if (!/^[a-z0-9_]+$/.test(relayTemplate))
            throw new Error('invalid retained relay template');
          copies.push(retainedDatabase);
          await admin(
            `CREATE DATABASE ${retainedDatabase} WITH TEMPLATE ${relayTemplate} OWNER relay`,
          );
          const relayUrl = new URL(retainedRelayTemplate);
          relayUrl.pathname = `/${retainedDatabase}`;
          return { retainedRelay: pool(relayUrl.toString()), relayUrl };
        },
        ordinal,
      );
      relayUrl.pathname = `/${retainedDatabase}`;
      const data = join(directory, `postgres-${ordinal}`);
      const logFile = join(directory, `postgres-${ordinal}.log`);
      pgCopies.push(data);
      candidateDirectories.add(data);
      candidateDirectories.add(logFile);
      await timing.phase(
        'candidate.postgres-filesystem-copy',
        () => {
          copyRecoveryTree(pgBackup, data);
          appendFileSync(
            join(data, 'postgresql.auto.conf'),
            "\narchive_mode = off\nrestore_command = 'false'\n",
          );
          writeFileSync(join(data, 'recovery.signal'), '');
        },
        ordinal,
      );
      let port = 0;
      let owners!: { account: Pool; access: Pool; content: Pool; relay: Pool };
      await timing.phase(
        'candidate.postgres-startup-recovery',
        async () => {
          port = await freePort();
          try {
            execFileSync(
              'pg_ctl',
              [
                '-D',
                data,
                '-l',
                logFile,
                '-o',
                `-h 127.0.0.1 -p ${port} -k ${socketDirectory} -c max_locks_per_transaction=${postgresRecoveryMaxLocks}`,
                '-t',
                '60',
                '-w',
                'start',
              ],
              { timeout: 65_000 },
            );
          } catch (error) {
            // Final disposal owns the failed copy; keep its refusal outside that custody.
            try {
              const fd = openSync(logFile, 'r');
              let logs: string;
              try {
                const size = fstatSync(fd).size;
                const tail = Buffer.alloc(Math.min(size, 8_000));
                const bytes = readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
                logs = tail.subarray(0, bytes).toString('utf8');
              } finally {
                closeSync(fd);
              }
              for (const [key, secret] of Object.entries(qa.composeEnv)) {
                if (secret && /(?:PASSWORD|SECRET|TOKEN|KEY)$/.test(key))
                  logs = logs.replaceAll(secret, '[redacted]');
              }
              const evidence = join(artifacts, `copied-postgres-startup-${suffix}-${ordinal}.log`);
              writeFileSync(evidence, logs.slice(-8_000), { mode: 0o600 });
              console.error(`copied PostgreSQL startup failed; evidence: ${evidence}\n${logs.slice(-8_000)}`);
            } catch { /* diagnostics must preserve the startup failure */ }
            throw error;
          }
          const restoredPool = (owner: keyof typeof source) => {
            const url = new URL(databases.urls[owner]);
            url.hostname = '127.0.0.1';
            url.port = String(port);
            url.username = 'postgres';
            url.password = qa.composeEnv.POSTGRES_PASSWORD!;
            return pool(url.toString());
          };
          owners = {
            account: restoredPool('account'),
            access: restoredPool('access'),
            content: restoredPool('content'),
            relay: restoredPool('relay'),
          };
          let recovering = true;
          for (let attempt = 0; attempt < 100 && recovering; attempt++) {
            recovering =
              (
                await owners.account.query<{ recovering: boolean }>(
                  'SELECT pg_is_in_recovery() AS recovering',
                )
              ).rows[0]?.recovering ?? true;
            if (recovering) await Bun.sleep(100);
          }
          expect(recovering).toBe(false);
          // Recovery connects as postgres while ordinary owner roles stay offline.
          await owners.account.query(
            'ALTER ROLE account NOLOGIN; ALTER ROLE access NOLOGIN; ALTER ROLE content NOLOGIN; ALTER ROLE relay NOLOGIN',
          );
        },
        ordinal,
      );
      let graph!: Awaited<ReturnType<typeof standaloneFuseki>>;
      let restoredVolume: string | undefined;
      await timing.phase(
        'candidate.graph-copy-startup',
        async () => {
          restoredVolume = volume(`copy-${ordinal}`);
          await copyGraph(cutVolume, restoredVolume);
          graph = await standaloneFuseki(
            qa.dockerEnv,
            {
              name: `rezics-owner-erasure-${suffix}-copy-${ordinal}`,
              image: image,
              volume: restoredVolume,
              secrets: fusekiSecrets(qa.composeEnv),
            },
            { onAllocated: graphResources.registerContainer },
          );
        },
        ordinal,
      );
      const fuseki = new FusekiClient(
        graph.url,
        qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN,
        qa.composeEnv.FUSEKI_COMMAND_TOKEN,
      );
      const restoredLineage = {
        dataEpoch: randomUUID(),
        routingEpoch: /^[0-9]+$/.test(lineage.routingEpoch)
          ? (BigInt(lineage.routingEpoch) + 1n).toString()
          : randomUUID(),
      };
      await timing.phase(
        'candidate.lineage-cutover',
        () =>
          cutoverRestoredGraphLineage(fuseki, {
            prior: { ...lineage, sequence: coverage!.priorSequence },
            next: restoredLineage,
          }),
        ordinal,
      );
      const restoredDirectory = join(directory, `objects-${ordinal}`);
      candidateDirectories.add(restoredDirectory);
      await timing.phase(
        'candidate.object-filesystem-copy',
        () => cpSync(backupObjects, restoredDirectory, { recursive: true }),
        ordinal,
      );
      const bound = await timing.phase(
        'candidate.remaining-runtime-binding',
        async () => {
          const restoredObjects = new DirectoryObjects(restoredDirectory);
          const restoredCustody = new ReceiptCustody(
            new PostgresReceiptCustodyStore(owners.access),
            restoredObjects,
            fuseki,
            qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
            proofRetirementSender(graph.url, qa.composeEnv.FUSEKI_COMMAND_TOKEN!),
          );
          const restoredEnv: WorkActivationEnvironment & { structureObjects: DirectoryObjects } = {
            fuseki,
            lineage: restoredLineage,
            objectDirectory: restoredDirectory,
            workObjects: restoredObjects,
            structureObjects: restoredObjects,
            receiptCustody: restoredCustody,
            structureGroupRoots: new StructureGroupRootStore(owners.content, restoredObjects),
            structureQualifierRoots: new StructureQualifierRootStore(
              owners.content,
              restoredObjects,
            ),
          };
          const resources: RestoreResources = {
            accountPool: owners.account,
            accessPool: owners.access,
            contentPool: owners.content,
            restoredRelayPool: owners.relay,
            ...(nativeAccessAttachment && attachmentCustody ? {
              nativeAccessAttachment: (reference) => readNativeAccessAttachment(reference,
                join(directory, 'native-access-attachments'), attachmentCustody!.offhost),
            } : {}),
            hmacKey: restoreKey,
            objectStore: {
              directory: restoredDirectory,
              workObjects: restoredObjects,
              structureObjects: restoredObjects,
              structureGroupRoots: restoredEnv.structureGroupRoots,
              structureQualifierRoots: restoredEnv.structureQualifierRoots,
            },
            erasures: {
              authority,
              originalSource: 'retained-native-event',
              signingKey: qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
              maintenance: heldErasureMaintenanceClient(
                graph.url,
                qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN!,
              ),
            },
          };
          const operations = new OwnerOperations(retainedRelay, restoredEnv, resources);
          const work: MainWorkDependencies = {
            environment: restoredEnv,
            structureObjects: restoredObjects,
            account: authenticated!.verifier,
            access: new AccessAdmissionRegistry(owners.access),
            content: new ContentCore(owners.content),
            ownerOperations: operations,
          };
          const recipeRequest = createRecipeApiRequest(fuseki, work, currentOwnerToken);
          const app = new Elysia().use(ownerRoutes(work)).use(healthRoutes(fuseki, work));
          const request = async (
            key: string = randomUUID(),
            token?: string,
            body: Parameters<RestoreChecks['reconcile']>[1] = {
              profile: 'owner-reconciliation-v1',
              kind: 'restore',
              sealedCoverage: authority.sealedCoverage,
              sealedDeletionSets: [],
            },
          ) => {
            const bearer = token ?? (await currentOwnerToken());
            return app.handle(
              new Request('http://main.local/v1/owners/reconciliations', {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${bearer}`,
                  'content-type': 'application/json',
                  'idempotency-key': key,
                },
                body: JSON.stringify(body),
              }),
            );
          };
          const ready = () => app.handle(new Request('http://main.local/health/ready'));
          // Native HTTP exposes admitted commands, not raw SPARQL updates. A
          // graph fault edits only this stopped disposable owner's TDB custody.
          const faultGraph = async (sparql: string) => {
            const delimiter = `OWNER_ERASURE_GRAPH_FAULT_${randomUUID().replaceAll('-', '')}`;
            graph.runner.stop();
            try {
              graph.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/owner-erasure-fault.ru <<'${delimiter}'
${sparql}
${delimiter}
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/owner-erasure-fault.ru`);
            } finally {
              await graph.runner.start();
            }
          };
          const faultRetained = async (
            sql: string | readonly { sql: string; values?: unknown[] }[],
            values: unknown[] = [],
          ) => {
            const url = new URL(relayUrl);
            url.username = 'postgres';
            url.password = qa.composeEnv.POSTGRES_PASSWORD!;
            const client = new Client({ connectionString: url.toString() });
            await client.connect();
            try {
              await client.query('BEGIN');
              await client.query('SET LOCAL session_replication_role = replica');
              const statements = typeof sql === 'string' ? [{ sql, values }] : sql;
              if (!statements.length) throw new Error('retained test fault has no SQL statements');
              const first = await client.query(statements[0]!.sql, statements[0]!.values ?? []);
              for (const statement of statements.slice(1))
                await client.query(statement.sql, statement.values ?? []);
              await client.query('COMMIT');
              return first;
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              await client.end();
            }
          };
          return {
            app,
            owners,
            retainedRelay,
            resources,
            fuseki,
            lineage: restoredLineage,
            directory: restoredDirectory,
            custody: restoredCustody,
            recipeRequest,
            request,
            ready,
            faultGraph,
            faultRetained,
          };
        },
        ordinal,
      );
      const disposeResources = createRestoreCopyDisposal([
        ...[...Object.values(owners), retainedRelay].map((owner, index) => ({
          resource: `candidate pool ${ordinal}.${index + 1}`,
          run: () => closePool(owner),
        })),
        {
          resource: `candidate graph ${ordinal}`,
          run: () => removeContainer(graph),
        },
        {
          resource: `candidate PostgreSQL ${ordinal}`,
          run: () => stopPostgres(data),
        },
        {
          resource: `candidate retained relay database ${ordinal}`,
          run: async () => {
            if (!/^[a-z0-9_]+$/.test(retainedDatabase))
              throw new Error('invalid retained relay database name');
            await admin(`DROP DATABASE IF EXISTS ${retainedDatabase} WITH (FORCE)`);
            const index = copies.indexOf(retainedDatabase);
            if (index >= 0) copies.splice(index, 1);
          },
        },
        {
          resource: `candidate graph volume ${ordinal}`,
          run: () => {
            if (!restoredVolume) return;
            removeVolume(restoredVolume);
          },
        },
        {
          resource: `candidate directories ${ordinal}`,
          run: async () => {
            const failures = await attemptRestoreCleanup(
              [data, logFile, restoredDirectory].map((path) => ({
                resource: `candidate directory ${path}`,
                run: () => removeCandidateDirectory(path),
              })),
            );
            if (failures.length)
              throw restoreCleanupError(failures, `candidate ${ordinal} directory cleanup failed`);
          },
        },
      ]);
      const dispose = () => timing.phase('candidate.disposal', disposeResources, ordinal);
      const copyElapsedMs = Date.now() - copyStarted;
      console.info('owner restore erasure copy ready', { ordinal, elapsedMs: copyElapsedMs });
      expect(copyElapsedMs).toBeLessThan(600_000);
      return {
        ...bound,
        ordinal,
        dispose,
      };
    };
    const retain = async (context: SourceContext) => {
      if (retained) throw new Error('a restored consumer cannot republish source custody');
      await authenticated!.stop();
      const sourceVolumes = retainedSourceVolumes(context.key);
      await timing.phase('source.immutable-publication-copy', async () => {
        await copyGraph(cutVolume, sourceVolumes.cut);
        live.runner.stop();
        await copyGraph(liveVolume, sourceVolumes.current);
        cpSync(backupObjects, join(context.backup, 'objects-cut'), { recursive: true });
        cpSync(objects.directory, join(context.backup, 'objects-current'), { recursive: true });
        copyRecoveryTree(pgBackup, join(context.backup, 'postgres-cut'));
        writeFileSync(join(context.backup, 'rdf-cut.json'), stable(rdfCut), { mode: 0o600 });
        // The post-cut relay template and signed authority are a second physical frontier.
        // It must survive independently of the old QA cluster, alongside the historical cut.
        const remote = `/tmp/rezics-retained-owner-${suffix}`;
        try {
          const copied = qa.compose(['exec', '-T', '-u', 'postgres', 'postgres', 'sh', '-ec',
            `PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -p 5432 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast`], 65_000);
          if (copied.status !== 0) throw new Error('retained post-cut PostgreSQL backup failed');
          const container = qa.compose(['ps', '-q', 'postgres']).output.trim();
          if (!/^[0-9a-f]{12,64}$/.test(container)) throw new Error('retained PostgreSQL container is unavailable');
          docker(['cp', `${container}:${remote}`, join(context.backup, 'postgres-current')]);
          execFileSync('pg_verifybackup', ['--no-parse-wal', join(context.backup, 'postgres-current')], { timeout: 15_000 });
        } finally {
          const removed = qa.compose(['exec', '-T', '-u', 'postgres', 'postgres', 'rm', '-rf', remote], 10_000);
          if (removed.status !== 0) throw new Error('retained post-cut PostgreSQL export cleanup failed');
        }
        if (attachmentCustody) {
          writeFileSync(join(context.backup, 'attachment-secret.gpg'), execFileSync('gpg', ['--batch', '--export-secret-keys', attachmentCustody.recipient], { env: attachmentCustody.offhost, timeout: 60_000 }), { mode: 0o600 });
          writeFileSync(join(context.backup, 'attachment-public.gpg'), execFileSync('gpg', ['--batch', '--export', attachmentCustody.recipient], { env: attachmentCustody.publicOnly, timeout: 60_000 }), { mode: 0o600 });
          cpSync(join(directory, 'native-access-attachments'), join(context.backup, 'native-access-attachments'), { recursive: true });
        }
      });
      const { liveVolume: _liveVolume, cutVolume: _cutVolume, native: _native, live: _live, custody: _custody, currentOwnerToken: _token, ...facts } = state;
      const secrets = Object.fromEntries(['POSTGRES_PASSWORD', 'FUSEKI_MAINTENANCE_TOKEN', 'FUSEKI_COMMAND_TOKEN', 'FUSEKI_TITLE_ADMISSION_KEY', 'FUSEKI_CONTENT_PROJECTION_KEY'].map(key => [key, qa.composeEnv[key]]));
      const metadata = JSON.parse(JSON.stringify({ contract: 'owner-erasure-source-v1', facts, databaseUrls: databases.urls,
        auth: authenticated!.retainedAuth, secrets, attachmentRecipient: attachmentCustody?.recipient ?? null })) as RetainedOwnerState;
      const ownerState = JSON.parse(JSON.stringify({ coverage, authority, newerCoverage, newerAuthority, original, erased,
        generation, lineage, retainedRelayTemplate, volumes: {
          cut: retainedVolumeInventory(sourceVolumes.cut, qa.dockerEnv),
          current: retainedVolumeInventory(sourceVolumes.current, qa.dockerEnv),
        } })) as RetainedOwnerState;
      return { metadata, ownerState, rdfDigest: hash(stable(rdfCut)),
        producerRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        qaIdentity: runId, phases: timing.durations() };
    };
    const preparationElapsedMs = Date.now() - preparationStarted;
    console.info('owner restore erasure cut ready', { elapsedMs: preparationElapsedMs });
    expect(preparationElapsedMs).toBeLessThan(600_000);
    return {
      retain,
      source,
      native,
      sourceLineage: lineage,
      beforeCutMembershipProof,
      beforeCutApiSeedResult,
      custody,
      coverage,
      authority,
      baseCoverage: coverage,
      baseAuthority: authority,
      currentCoverage: newerCoverage,
      currentAuthority: newerAuthority,
      newerAuthority,
      generation,
      laterAdmission,
      nativeAccessAttachment,
      attachmentCustody,
      original,
      erased,
      revisionId,
      quotedSource,
      availableBeforeErasure,
      laterRevisionId,
      work: created.work,
      retired,
      backupObjects,
      backupLabel,
      historicalManifest,
      historicalPayload: manifest.payload.slice(7),
      modelShape: prepared.envelope.validations[0]!.sha256,
      principal,
      actor: actor,
      published,
      principalId: principalId,
      leaseTemplates,
      stopOriginal: () => live.runner.stop(),
      timing,
      copy,
      close,
    };
  } catch (error) {
    for (const handle of [sourceApiPhase, sourceProofPhase]) {
      if (!handle) continue;
      try {
        timing.fail(handle);
      } catch {
        // Preserve the fixture's original failure if writing timing evidence also fails.
      }
    }
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'restore fixture creation failed and final disposal was incomplete',
      );
    }
    throw error;
  }
}

function retainedSourceVolumes(key: string) {
  const project = fixtureProject(`rs-${hash(key)}`);
  return { cut: `${project}_fuseki_cut`, current: `${project}_fuseki_current` };
}

/** Inventory mounted custody read-only; copyVolume remains the sole volume copier. */
function retainedVolumeInventory(volume: string, docker: NodeJS.ProcessEnv): Record<string, RetainedFileIntegrity> {
  if (!volumeExists(volume, docker)) throw new Error(`retained graph volume is missing: ${volume}`);
  const output = run('docker', ['run', '--rm', '--network', 'none', '--user', '0:0',
    '--mount', `type=volume,source=${volume},target=/backup,readonly,volume-nocopy`,
    '--entrypoint', 'sh', postgresImage(), '-ec',
    `cd /backup
test -z "$(find . -type l -print -quit)"
find . -type f -exec sh -c 'for file do
  digest=$(sha256sum "$file"); bytes=$(stat -c %s "$file")
  printf "%s\\t%s\\t%s\\n" "${'${digest%% *}'}" "$bytes" "${'${file#./}'}"
done' sh {} +`], docker, 60_000);
  const inventory: Record<string, RetainedFileIntegrity> = {};
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]{64})\t([0-9]+)\t([^\t\n]+)$/.exec(line);
    if (!match || match[3]!.split('/').some(part => part === '..' || !part))
      throw new Error('retained volume inventory is invalid');
    inventory[match[3]!] = { sha256: match[1]!, bytes: Number(match[2]) };
  }
  if (!Object.keys(inventory).length) throw new Error('retained graph volume is empty');
  return inventory;
}

/** Relative import closure binds the actual producer/helper/service bytes rather than Git HEAD. */
function producerModules(root: string, initial: readonly string[]): string[] {
  const paths = new Set<string>();
  const visit = (path: string) => {
    if (paths.has(path)) return;
    const full = resolve(root, path);
    if (relative(root, full).startsWith('..')) throw new Error('producer input escapes checkout');
    paths.add(path);
    if (!path.endsWith('.ts')) return;
    for (const match of readFileSync(full, 'utf8').matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      const dependency = resolve(dirname(full), match[1]!);
      if (existsSync(dependency)) visit(relative(root, dependency));
      else if (existsSync(`${dependency}.ts`)) visit(relative(root, `${dependency}.ts`));
    }
  };
  for (const path of initial) visit(path);
  // Runtime model/native definitions are read as data rather than imported TS modules.
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.add(path);
    }
  };
  for (const directory of ['packages/model/src', 'infra/fuseki']) walk(directory);
  return [...paths].sort();
}

export function ownerErasureSourceAdapter(options: OwnerRestoreErasureFixtureOptions = {}): RetainedSourceAdapter<RetainedOwnerState, Awaited<ReturnType<typeof runOwnerRestoreErasureFixture>>> {
  if (Boolean(options.beforeCutApiSeed) !== Boolean(options.beforeCutSource))
    throw new Error('foreground seed requires explicit source identity, inputs and files');
  if (options.beforeCutSource && (!options.beforeCutSource.identity || !options.beforeCutSource.files.length))
    throw new Error('foreground seed requires an authored identity and source-affecting files');
  const root = resolve(import.meta.dir, '../../..');
  const docker = qaStack(requireFaultTier().runId).dockerEnv;
  const engines = currentEngines(docker);
  const modules = producerModules(root, ['tests/qa/fault-recovery/owner-restore-erasure-fixture.ts',
    'yarn.lock', 'package.json', 'services/main/package.json', 'services/content/package.json', 'services/account/package.json',
    ...(options.beforeCutSource?.files ?? [])]);
  const specification = {
    producer: 'owner-erasure-source', version: '1',
    files: { ...sourceFileDigests(root, modules), ...migrationInventory(root) },
    inputs: {
      primaryBody: 'erased native HTTP fixture payload', laterBody: 'later retained journal fixture payload',
      quotedBody: 'authored annotation stays', language: 'en', direction: 'ltr',
      foregroundSeed: options.beforeCutSource ?? null, laterApiAdmission: options.laterApiAdmission ?? false,
    },
    compatibility: JSON.parse(JSON.stringify({ engines, selectedNativeImage: pinnedImage(),
      modelGeneration: fixtureModel(root).generation, postgresNative: execFileSync('pg_config', ['--version'], { encoding: 'utf8' }).trim() })) as RetainedOwnerState,
  };
  return {
    specification,
    build: async context => {
      const fixture = await runOwnerRestoreErasureFixture(options);
      let result: Awaited<ReturnType<typeof fixture.retain>>;
      try { result = await fixture.retain(context); } finally { await fixture.close(); }
      return { ...result, phases: fixture.timing.durations() };
    },
    verify: async (context, manifest) => {
      const evidence: string[] = [];
      if (manifest.metadata.contract !== 'owner-erasure-source-v1') evidence.push('owner source contract differs');
      const facts = manifest.metadata.facts as RetainedOwnerState | undefined;
      if (!facts || !manifest.metadata.auth || !manifest.metadata.secrets || !manifest.metadata.databaseUrls)
        evidence.push('owner source runtime descriptor is incomplete');
      else for (const field of ['coverage', 'authority', 'newerCoverage', 'newerAuthority', 'original', 'erased', 'generation', 'lineage', 'retainedRelayTemplate']) {
        if (facts[field] === undefined || stable(facts[field]) !== stable(manifest.integrity.ownerState[field]))
          evidence.push(`owner source descriptor differs: ${field}`);
      }
      const volumes = retainedSourceVolumes(context.key);
      const stored = manifest.integrity.ownerState.volumes as unknown as Record<'cut' | 'current', Record<string, RetainedFileIntegrity>>;
      for (const kind of ['cut', 'current'] as const) {
        if (stable(retainedVolumeInventory(volumes[kind], docker)) !== stable(stored[kind]))
          evidence.push(`retained ${kind} graph physical inventory differs`);
      }
      if (hash(readFileSync(join(context.backup, 'rdf-cut.json'))) !== manifest.integrity.rdfDigest)
        evidence.push('retained RDF digest differs');
      for (const kind of ['postgres-cut', 'postgres-current'])
        execFileSync('pg_verifybackup', ['--no-parse-wal', join(context.backup, kind)], { timeout: 15_000 });
      return evidence;
    },
    restore: (context, manifest) => runOwnerRestoreErasureFixture(options, { context, manifest }),
    dispose: fixture => fixture.close(),
    remove: async key => {
      if (!key.startsWith('rs-owner-erasure-source-')) throw new Error('source removal belongs to another producer');
      const volumes = Object.values(retainedSourceVolumes(key)).filter(name => volumeExists(name, docker));
      if (volumes.length) removeVolumes(volumes, docker);
    },
  };
}

export async function prepareOwnerErasureSource(options: OwnerRestoreErasureFixtureOptions = {}) {
  return new RetainedSources().prepare(ownerErasureSourceAdapter(options));
}

export async function ownerRestoreErasureFixture(options: OwnerRestoreErasureFixtureOptions = {}) {
  const adapter = ownerErasureSourceAdapter(options);
  const selectedKey = process.env.OWNER_ERASURE_SOURCE_KEY;
  if (selectedKey && selectedKey !== sourceKey(adapter.specification))
    throw new Error('harness selected incompatible owner-erasure source inputs');
  const restored = await new RetainedSources().restore(adapter);
  console.info('owner-erasure retained source consumed', { key: restored.manifest.key, digest: restored.manifest.digest,
    integrity: restored.manifest.integrity.digest, producerRevision: restored.manifest.provenance.producerRevision,
    qaIdentity: restored.manifest.provenance.qaIdentity, elapsedMs: restored.elapsedMs, admissionWaitMs: restored.admissionWaitMs });
  return { ...restored.candidate, close: async () => {
    await restored.dispose();
    console.info('owner-erasure retained source immutable after consumption', {
      key: restored.manifest.key, digest: restored.manifest.digest, integrity: restored.manifest.integrity.digest,
    });
  } };
}

if (import.meta.main) {
  const evidenceIndex = process.argv.indexOf('--evidence');
  if (!process.argv.includes('--prepare-retained-source') || evidenceIndex < 0 || !process.argv[evidenceIndex + 1])
    throw new Error('select --prepare-retained-source --evidence <path>');
  const report = await prepareOwnerErasureSource({ laterApiAdmission: process.argv.includes('--later-api-admission') });
  writeFileSync(process.argv[evidenceIndex + 1]!, `${stable(report)}\n`, { mode: 0o600 });
}

export type Fixture = Awaited<ReturnType<typeof runOwnerRestoreErasureFixture>>;
export type Copy = Awaited<ReturnType<Fixture['copy']>>;

export function operatorContext(fixture: Fixture, copy: Copy): OperatorRestoreReleaseContext {
  return {
    budget: new RecoveryBudget(),
    fuseki: copy.fuseki,
    apps: {
      MAIN_DATA_EPOCH: copy.lineage.dataEpoch,
      MAIN_ROUTING_EPOCH: copy.lineage.routingEpoch,
    },
    manifest: {
      sealedCoverage: fixture.authority.sealedCoverage,
      sealedDeletionSets: [],
      fenceGeneration: fixture.generation,
    },
    pools: copy.owners,
  };
}

export async function ownerLogins(copy: Copy) {
  return (
    await copy.owners.account.query<{ rolname: string; rolcanlogin: boolean }>(
      "SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname IN ('account','access','content','relay') ORDER BY rolname",
    )
  ).rows;
}

export async function outerOperation(copy: Copy, key: string) {
  const record = (
    await copy.retainedRelay.query<{ id: string; state: string; hold_reason: string | null }>(
      'SELECT id,state,hold_reason FROM relay.owner_reconciliation WHERE operation_id=$1',
      ['owner:reconcile:' + key],
    )
  ).rows[0]!;
  const bindings = (
    await copy.retainedRelay.query<{ item_ref: string }>(
      `SELECT item_ref FROM relay.owner_reconciliation_item WHERE reconciliation_id=$1
       AND item_ref ~ '^restore-(qualification|release):' ORDER BY ordinal`,
      [record.id],
    )
  ).rows.map((row) => row.item_ref);
  const erasures = (
    await copy.retainedRelay.query<{ id: string; state: string; outcome_digest: string }>(
      'SELECT id,state,outcome_digest FROM relay.owner_reconciliation WHERE operation_id=$1',
      ['owner:reconcile:' + key + ':erasures'],
    )
  ).rows[0];
  return {
    ...record,
    erasures,
    qualifications: bindings.filter((ref) => ref.startsWith('restore-qualification:')),
    releases: bindings.filter((ref) => ref.startsWith('restore-release:')),
  };
}

export async function graphReleased(copy: Copy) {
  return (
    await copy.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
      <${DATASET}> rv:dataEpoch "${copy.lineage.dataEpoch}" ; rv:sequence 0 .
      FILTER NOT EXISTS { <${DATASET}> rv:restoreHold true } } }`)
  ).boolean;
}

export async function accessFence(copy: Copy) {
  return (
    await copy.owners.access.query<{ open: boolean; generation: string }>(
      'SELECT open,generation::text AS generation FROM access.recovery_fence WHERE id=true',
    )
  ).rows;
}

/** Same operator command and key for every attempt; only the reconcile call may fail. */
export function operatorAttempt(fixture: Fixture, copy: Copy, key: string) {
  return finishOperatorRestore(
    operatorContext(fixture, copy),
    { reconcile: (_context, body, attempt) => copy.request(attempt, undefined, body) },
    key,
    () => {},
  );
}

export async function failOuterOutcome(copy: Copy, key: string) {
  // Model a lost commit answer with PostgreSQL transaction_resolution_unknown.
  await copy.faultRetained([
    {
      sql: `CREATE FUNCTION relay.g1351_fail_outer_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state = 'reconciled' AND NEW.operation_id = 'owner:reconcile:${key}' THEN
            RAISE EXCEPTION 'fault: outer restore outcome write' USING ERRCODE = '08007';
          END IF;
          RETURN NEW;
        END $$`,
    },
    {
      sql: `CREATE TRIGGER g1351_fail_outer_outcome BEFORE UPDATE ON relay.owner_reconciliation
        FOR EACH ROW EXECUTE FUNCTION relay.g1351_fail_outer_outcome()`,
    },
  ]);
}

export async function repairOuterOutcome(copy: Copy) {
  await copy.faultRetained([
    { sql: 'DROP TRIGGER g1351_fail_outer_outcome ON relay.owner_reconciliation' },
    { sql: 'DROP FUNCTION relay.g1351_fail_outer_outcome()' },
  ]);
}

export const FAILED = /Owner reconciliation did not verify the restore \(50[0-9]/;

/** A lost outer outcome: both owners committed and only the outcome write failed. */
export async function lostOutcome(fixture: Fixture, copy: Copy) {
  const key = randomUUID();
  await failOuterOutcome(copy, key);
  await expect(operatorAttempt(fixture, copy, key).catch((error: unknown) => {
    console.info('owner restore erasure outcome write refused', {
      message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    throw error;
  })).rejects.toThrow(FAILED);
  await repairOuterOutcome(copy);
  const lost = await outerOperation(copy, key);
  expect(lost).toMatchObject({ state: 'running' });
  expect(lost.releases).toHaveLength(1);
  expect(await accessFence(copy)).toEqual([
    { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
  ]);
  console.info('owner restore erasure lost outcome retained', {
    state: lost.state,
    releases: lost.releases.length,
  });
  return { key, lost };
}

/**
 * A refused completion cannot close a release that already committed, so the
 * actual surfaces are asserted: the operation settles as held, the verified
 * restore evidence and owner logins stay closed, the operator command fails and
 * Access/graph keep the committed release.
 */
export async function expectRefusedCompletion(
  fixture: Fixture,
  copy: Copy,
  key: string,
  reason: RegExp,
) {
  const response = await copy.request(key);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { state: string; disposition: string };
  expect(body.state).toBe('held');
  expect(['conflict', 'unavailable', 'corrupt']).toContain(body.disposition);
  const held = await outerOperation(copy, key);
  expect(held.state).toBe('held');
  expect(held.hold_reason).toMatch(reason);
  await expect(operatorAttempt(fixture, copy, key)).rejects.toThrow(
    'Owner reconciliation did not verify the restore',
  );
  expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(await graphReleased(copy)).toBe(true);
  expect(await accessFence(copy)).toEqual([
    { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
  ]);
  expect((await copy.ready()).status).toBe(200);
  await expect(
    new AccessAdmissionRegistry(copy.owners.access).activePrincipalId(fixture.principal),
  ).resolves.toBeDefined();
  return held;
}

export async function replicaAccess(copy: Copy, sql: string, values: unknown[] = []) {
  const client = await copy.owners.access.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function failAccessCommit(copy: Copy) {
  // The deferred write must roll back as a transient lock-unavailable commit.
  const client = await copy.owners.access.connect();
  try {
    await client.query(`CREATE FUNCTION access.g1351_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fault: Access commit' USING ERRCODE = '55P03'; END $$`);
    await client.query(`CREATE CONSTRAINT TRIGGER g1351_fail_commit AFTER UPDATE ON access.recovery_fence
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.open) EXECUTE FUNCTION access.g1351_fail_commit()`);
  } finally {
    client.release();
  }
}

export async function repairAccessCommit(copy: Copy) {
  const client = await copy.owners.access.connect();
  try {
    await client.query('DROP TRIGGER g1351_fail_commit ON access.recovery_fence');
    await client.query('DROP FUNCTION access.g1351_fail_commit()');
  } finally {
    client.release();
  }
}

export async function liveAccess(copy: Copy) {
  const client = await copy.owners.access.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = await accessStateCoverage(copy.owners.access, client);
    const outbox = await accessOutboxCoverage(copy.owners.access, client);
    await client.query('COMMIT');
    return { state, outbox };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
