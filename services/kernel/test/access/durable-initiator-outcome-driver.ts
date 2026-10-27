import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { Pool, type PoolClient } from 'pg';
import { createContentOperationClient, createContentWork } from '../../src/content/work.ts';
import { createAccess } from '../../src/access/index.ts';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { contentEffects } from '../../src/content/relays.ts';
import { R2Storage } from '../../src/content/r2-storage.ts';
import { effectsRelay } from '../../src/events/effects.ts';
import { startRelays } from '../../src/events/relays.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { composeWork } from '../../src/work/registry.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { authoritativeTimeValue, mintReadTime, runCommand } from '../../src/command/command.ts';
import { accessCommandAttempt, commandAccessContext } from '../../src/access/command-admission.ts';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeJwt } from 'jose';
import reylo from 'reylo/esbuild';
import type {
  Attack,
  Anchor,
  Attempt,
  ReadStage,
  DurableInitiatorDriver,
  Fixture,
  Point,
  Snapshot,
} from '../../../../specs/durable-initiator-driver.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { grantGroupRole } from '../../src/access/resource-group-grant.ts';
import { readErasureInitiator } from '../../src/content/erasure-initiator.ts';
import { createRealmMembership, readMembershipInitiator } from '../../src/community/membership.ts';
import { communityWorkModule } from '../../src/community/work.ts';
import { createAccountsWorkModule } from '../../src/access/membership-work.ts';
import { readPost } from '../../src/content/reads.ts';
import { readMembershipWorkConfig } from '../../src/access/membership-work-config.ts';
import { readOperation } from '../../src/content/operations.ts';
import { withConnection } from '../../src/database/pool.ts';
import { accessCommandAuthorization, type AccountActor, type Resource } from '../../src/request/access.ts';
import type { PublicGrantSubject } from '../../src/access/grant-subject.ts';
import { CONTENT_QUEUES } from '../../src/content/work-contract.ts';
import {
  buildBoardAndThreads,
  createFixtureResources,
  request,
  type FixtureResources,
} from '../content/support/erasure-operation-fixtures.ts';

const barrierTable = 'content.erasure_operation_test_barrier';
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 15));
let workerBundle: Promise<string> | undefined;

/** IPC preserves the executor's opaque time identities separately from values.
 * Different native time objects must remain different after transport.
 */
function encodeAttempt(attempt: Attempt): string {
  const references = new WeakMap<object, string>();
  return JSON.stringify(attempt, (key, value: unknown) => {
    if (typeof value === 'bigint') return { nativeBigIntValue: value.toString() };
    if (key !== 'time') return value;
    if (typeof value !== 'object' || value === null) throw new Error('Missing native time object');
    let reference = references.get(value);
    if (reference === undefined) references.set(value, (reference = randomUUID()));
    return { nativeTimeReference: reference };
  });
}

function decodeAttempt(wire: Attempt): Attempt {
  const revived = JSON.parse(JSON.stringify(wire), (_key, value: unknown) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      Object.keys(value).length === 1 &&
      typeof (value as { nativeBigIntValue?: unknown }).nativeBigIntValue === 'string'
    )
      return BigInt((value as { nativeBigIntValue: string }).nativeBigIntValue);
    return value;
  }) as Attempt;
  const references = new Map<string, object>();
  const time = (value: object) => {
    const reference = (value as { nativeTimeReference?: unknown }).nativeTimeReference;
    if (typeof reference !== 'string') throw new Error('Missing worker time reference');
    let object = references.get(reference);
    if (object === undefined) references.set(reference, (object = Object.freeze(value)));
    return object;
  };
  return {
    ...revived,
    time: time(revived.time),
    checks: revived.checks.map((check) => ({ ...check, time: time(check.time) })),
  };
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 60_000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await sleep();
  } while (Date.now() < deadline);
  throw new Error('Native erasure observation timed out');
}

async function inNativeGrantBatches<T>(values: readonly T[], apply: (value: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < values.length; start += 16) await Promise.all(values.slice(start, start + 16).map(apply));
}

async function buildWorker(): Promise<string> {
  const directory = fileURLToPath(new URL('../../.temp/durable-initiator-worker/', import.meta.url));
  mkdirSync(directory, { recursive: true });
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./durable-initiator-outcome-driver.ts', import.meta.url))],
    outdir: directory,
    target: 'bun',
    splitting: true,
    packages: 'external',
    plugins: [
      reylo(),
      {
        name: 'external-parent-imports',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind !== 'dynamic-import' || args.path.includes('growth.ts')) return;
            if (args.path.startsWith('@') || !args.path.startsWith('.')) return { path: args.path, external: true };
            return { path: resolve(args.resolveDir, args.path), external: true };
          });
        },
      },
    ],
  });
  if (!built.success) throw new Error(built.logs.map((log) => log.message).join('\n'));
  const entry = built.outputs.find((output) => output.kind === 'entry-point');
  if (!entry) throw new Error('Native worker build has no entry point');
  return entry.path;
}

/** Launch the native content registration with observable SDK step barriers.
 * This process owns only the child and the randomly cloned fixture databases.
 */
async function startWorker(resources: FixtureResources, executorId: string) {
  const entry = await (workerBundle ??= buildWorker());
  await resources.pool.query(`CREATE TABLE IF NOT EXISTS ${barrierTable} (
    workflow_id text NOT NULL, serial integer NOT NULL, name text NOT NULL,
    released boolean NOT NULL DEFAULT false, checks jsonb, error text, attempt jsonb,
    PRIMARY KEY (workflow_id,serial)
  )`);
  const child = Bun.spawn([process.execPath, entry], {
    env: workerTestEnv({
      DURABLE_INITIATOR_WORKER: '1',
      KERNEL_ROUTE_KEY: Buffer.from(resources.system.routeKey).toString('base64url'),
      KERNEL_SESSION_KEYS: [...resources.system.tokenKeys.keys]
        .map(([id, key]) => `${id}:${Buffer.from(key).toString('base64url')}`)
        .join(','),
      AUTH_ISSUER: String(decodeJwt(resources.system.actors.author.bearer).iss),
      AUTH_AUDIENCE: 'https://content.test',
      AUTH_JWKS_URL: `${String(decodeJwt(resources.system.actors.author.bearer).iss)}/.well-known/jwks.json`,
    }),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  let errors = '';
  const consume = async (stream: ReadableStream<Uint8Array>, append: (value: string) => void) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) append(decoder.decode(bytes, { stream: true }));
  };
  const stdout = consume(child.stdout, (value) => (output += value));
  const stderr = consume(child.stderr, (value) => (errors += value));
  child.stdin.write(
    `config ${JSON.stringify({
      databaseUrl: resources.appUrl,
      authDatabaseUrl: resources.system.database.authPool.options.connectionString,
      routeKey: Buffer.from(resources.system.routeKey).toString('base64url'),
      executorId,
      actions: [...resources.system.actions],
    })}\n`,
  );
  const wait = (line: string) =>
    until(async () => {
      if (output.includes(line)) return true;
      if (child.exitCode !== null) throw new Error(`Native worker exited: ${output}\n${errors}`);
      return undefined;
    });
  const assertRunning = () => {
    if (child.exitCode !== null) throw new Error(`Native worker exited: ${output}\n${errors}`);
  };
  const stop = async () => {
    if (child.exitCode === null) {
      // Leave parked work untouched. Restart must recover native DBOS state.
      child.stdin.write('stop\n');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), 10_000))),
      ]);
      clearTimeout(timer);
      if (!stopped && child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
    await Promise.all([stdout, stderr]);
  };
  const setClock = async (at: string) => {
    const id = randomUUID();
    child.stdin.write(`clock ${id} ${at}\n`);
    await wait(`ERASURE_WORKER_CLOCK ${id}`);
  };
  const result = async <T>(id: string): Promise<T> => {
    await until(async () => {
      if (new RegExp(`ERASURE_WORKER_RESULT ${id} [A-Za-z0-9_-]+`).test(output)) return true;
      const failure = new RegExp(`ERASURE_WORKER_ERROR ${id} ([A-Za-z0-9_-]+)`).exec(output)?.[1];
      if (failure) {
        const detail = JSON.parse(Buffer.from(failure, 'base64url').toString('utf8')) as {
          name: string;
          message: string;
        };
        const error = new Error(detail.message);
        error.name = detail.name;
        throw error;
      }
      if (child.exitCode !== null) throw new Error(`Native worker exited: ${output}\n${errors}`);
      return undefined;
    });
    const wire = new RegExp(`ERASURE_WORKER_RESULT ${id} ([A-Za-z0-9_-]+)`).exec(output)?.[1];
    if (!wire) throw new Error('Native worker result was not transported');
    return JSON.parse(Buffer.from(wire, 'base64url').toString('utf8')) as T;
  };
  const replay = async (operationId: string, pointId: string) => {
    const id = randomUUID();
    child.stdin.write(`replay ${id} ${operationId} ${pointId}\n`);
    const encoded = await result<string>(id);
    return decodeAttempt(JSON.parse(encoded) as Attempt);
  };
  const publicRead = async (operationId: string) => {
    const id = randomUUID();
    child.stdin.write(`public ${id} ${operationId}\n`);
    const value = await result<{ point: Point; anonymous: string; restored: string }>(id);
    return {
      point: value.point,
      anonymous: decodeAttempt(JSON.parse(value.anonymous) as Attempt),
      restored: decodeAttempt(JSON.parse(value.restored) as Attempt),
    };
  };
  const probe = async (operationId: string, point: Point, attack: Attack, input?: unknown) => {
    const id = randomUUID();
    const payload = Buffer.from(JSON.stringify({ operationId, point, attack, input })).toString('base64url');
    child.stdin.write(`probe ${id} ${payload}\n`);
    return decodeAttempt(JSON.parse(await result<string>(id)) as Attempt);
  };
  try {
    await wait('ERASURE_WORKER_READY');
    return { stop, setClock, replay, publicRead, probe, assertRunning };
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    await Promise.all([stdout, stderr]);
    throw new Error(
      `Native worker did not become ready: ${error instanceof Error ? error.message : String(error)}\n${output}\n${errors}`,
      { cause: error },
    );
  }
}

function isoAfter(value: string, milliseconds: number): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new TypeError('Invalid native fixture instant');
  return new Date(instant + milliseconds).toISOString();
}

async function isolatedFault(pool: Pool, change: (connection: PoolClient) => Promise<void>): Promise<string> {
  return withConnection(pool, async (connection) => {
    await connection.query('BEGIN');
    try {
      await connection.query('SET LOCAL session_replication_role = replica');
      await change(connection);
      const at = (await connection.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
      await connection.query('COMMIT');
      return at;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
  });
}

function nativeRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    ([
      'GrantDeniedError',
      'LifecycleDeniedError',
      'DelegationDeniedError',
      'DurableInitiatorUnavailableError',
      'ErasurePermissionDenied',
      'RealmMembershipUnavailableError',
    ].includes(error.name) ||
      (error as Error & { status?: number }).status === 403)
  );
}

function createLifecycleAccess(resources: FixtureResources) {
  const issuer = decodeJwt(resources.system.actors.author.bearer).iss;
  if (typeof issuer !== 'string') throw new Error('Native Auth credential has no issuer');
  return createAccess({
    actions: new Map([...resources.system.actions, ...LIFECYCLE_ACTIONS]),
    auth: {
      issuer,
      audience: 'https://content.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: (input, init) => resources.system.nativeAuth.handler(new Request(input, init)),
    },
    clock: () => new Date(),
  });
}

export async function createDurableInitiatorDriver(): Promise<DurableInitiatorDriver> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated kernel database');
  let resources: FixtureResources | undefined;
  let native: FixtureResources;
  let pool: Pool;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let externalClientId: string | undefined;
  let membershipClientId: string | undefined;
  let lifecycleClientId: string | undefined;
  let executorId = `durable-initiator-${randomUUID()}`;
  let fixtureDirty = false;
  let restoreMutation: (() => Promise<void>) | undefined;
  let trustedClock: string | undefined;
  let parked: { operation: Anchor; point: Point } | undefined;
  const pendingAdvances = new Map<string, Anchor>();
  const fixturesByOperation = new Map<string, Fixture>();
  const retireFixture = async () => {
    const failures: unknown[] = [];
    for (const stop of [
      () => worker?.stop(),
      () => client?.close(),
      async () => {
        resources?.stopBootstrap();
        await resources?.bootstrap;
        await resources?.system.close();
      },
    ]) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Durable initiator fixture cleanup failed');
  };
  let drainPending = async () => {};
  const close = retireFixture;
  const replaceFixture = async () => {
    if (resources) await retireFixture();
    native = resources = await createFixtureResources(databaseUrl);
    executorId = `durable-initiator-${randomUUID()}`;
    await native.bootstrap;
    pool = native.pool;
    client = await createWorkClient(native.appUrl);
    worker = await startWorker(native, executorId);
    if (trustedClock) await worker.setClock(trustedClock);
    externalClientId = undefined;
    membershipClientId = undefined;
    lifecycleClientId = undefined;
    fixtureDirty = false;
  };
  try {
    await replaceFixture();
    const operationRow = async (operation: Anchor) => {
      const result = await pool.query('SELECT * FROM content.operation WHERE route=$1 AND operation_id=$2', [
        operation.route,
        operation.id,
      ]);
      return result.rows[0];
    };
    const freshGovernanceActor = async (deadline: number) => {
      const row = (
        await pool.query<{ account_id: string }>(
          'SELECT account_id FROM access.governance_bootstrap WHERE route=$1 AND resource_id=$2',
          [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id],
        )
      ).rows[0];
      if (!row) throw new Error('Native governance identity is missing');
      const credential = await native.system.auth.issue({
        accountId: row.account_id,
        clientId: native.system.auth.ordinaryClient.id,
        scopes: [...native.system.actions.keys()].filter((action) => action !== 'media:complete'),
      });
      return native.system.access.authenticate(credential.bearer, { pool, deadline });
    };
    const freshAuthorActor = async (deadline: number) => {
      const credential = await native.system.auth.issue({
        accountId: native.accountIds.author,
        clientId: native.system.auth.ordinaryClient.id,
        scopes: [...native.system.actions.keys()].filter((action) => action !== 'media:complete'),
      });
      native.updateBearer('author', credential.bearer);
      return native.system.access.authenticate(credential.bearer, { pool, deadline });
    };
    const committedAt = async (transactionId: string) => {
      const result = await pool.query<{ at: string }>(
        'SELECT created_at::text AS at FROM core.receipt WHERE transaction_id=$1 ORDER BY created_at DESC LIMIT 1',
        [transactionId],
      );
      return (
        result.rows[0]?.at ?? (await pool.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at
      );
    };
    const driver: DurableInitiatorDriver = {
      close,
      async seed(mode = 'delegated') {
        if (!['direct', 'delegated', 'organization', 'realm'].includes(mode)) throw new TypeError('Unknown seed mode');
        await drainPending();
        if (restoreMutation) {
          await restoreMutation();
          restoreMutation = undefined;
        }
        if (fixtureDirty) await replaceFixture();
        fixtureDirty = false;
        parked = undefined;
        const authorActor = await freshAuthorActor(Date.now() + 120_000);
        // Native erasure discovers a second protected batch only after the first
        // has committed, so seed enough real posts for two pages.
        const board = await buildBoardAndThreads(native, 101, 1, randomUUID());
        const posts = board.targeted.map((post) => post.id);
        const actorId = native.accountIds.author;
        let principalId: string | null = mode === 'delegated' ? native.accountIds.unrelated : null;
        const lifecycleAccess = createLifecycleAccess(native);
        const lifecycle = createLifecycleCommands({ pool, access: lifecycleAccess });
        const internal = createLifecycleInternals({
          pool,
          routeKey: native.system.routeKey,
          provisioningEvidence: async () => null,
          recoveryEvidence: async () => null,
        });
        const grants = createGrantCommands({ pool, access: native.system.access, managementAction: 'access:grant' });
        const authorContext = () => ({ pool, actor: authorActor, deadline: Date.now() + 120_000 });
        const addRealmRole = async (resource: Resource, realmId: string) => {
          const context = authorContext();
          const authorization = await accessCommandAuthorization(
            native.system.access,
            authorActor,
            'access:grant',
            resource,
            context,
            () => new Error('Native resource grant denied'),
          );
          await runCommand(
            pool,
            {
              partition: partitionOf(resource.route),
              deadline: context.deadline,
              basis: {
                actorAccountId: authorActor.accountId,
                clientId: authorActor.clientId,
                requestedBy: authorActor.requestedBy,
              },
              authorization,
            },
            async (tx) => {
              await grantGroupRole(tx, {
                resource,
                principal: { kind: 'realm', id: realmId },
                role: 'member',
                resourceRole: 'content.post.owner',
              });
              return {
                value: {
                  resource,
                  principal: { kind: 'realm', id: realmId },
                  role: 'member',
                  resourceRole: 'content.post.owner',
                },
                events: [
                  {
                    type: 'com.rezics.fixture.created.v1',
                    subject: resource.id,
                    data: {
                      realmGroupRole: {
                        resource,
                        realmId,
                        role: 'member',
                        resourceRole: 'content.post.owner',
                      },
                    },
                  },
                ],
              };
            },
          );
        };
        const governanceActor = await freshGovernanceActor(Date.now() + 120_000);
        const governanceContext = () => ({ pool, actor: governanceActor, deadline: Date.now() + 120_000 });
        let organizationOwner = await lifecycleAccess.authenticate(native.system.actors.other.bearer, {
          pool,
          deadline: Date.now() + 120_000,
        });
        const ownerContext = () => ({ actor: organizationOwner, deadline: Date.now() + 120_000 });
        const addGroupGrant = async (id: string, subject: PublicGrantSubject, actions: string[]) => {
          await grants.create(authorContext(), {
            resource: { route: board.route, id },
            subject,
            actions,
            valid: '(,)',
            key: randomUUID(),
          });
        };
        const grantIfAbsent = async (
          grantor: 'author' | 'governance',
          input: {
            resource: { route: number; id: string };
            subject: { kind: 'account'; id: string };
            actions: readonly string[];
            valid?: string;
          },
        ) => {
          const existing = await pool.query<{ action: string }>(
            `SELECT action FROM access.resource_grant
             WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
               AND subject_role='' AND action=ANY($4::text[]) AND upper_inf(valid)`,
            [input.resource.route, input.resource.id, input.subject.id, input.actions],
          );
          const present = new Set(existing.rows.map((row) => row.action));
          const missing = input.actions.filter((action) => !present.has(action));
          if (missing.length > 0)
            await grants.create(grantor === 'author' ? authorContext() : governanceContext(), {
              ...input,
              actions: missing,
              valid: input.valid ?? '(,)',
              key: randomUUID(),
            });
        };
        let requestedBy: string | undefined;
        if (mode === 'organization') {
          if (!membershipClientId) {
            membershipClientId = `membership_${randomUUID().replaceAll('-', '')}`;
            await native.system.nativeAuth.internal.registerClient({
              clientId: membershipClientId,
              firstParty: true,
              scopes: ['account:read', 'organization:membership'],
            });
          }
          const ownerCredential = await native.system.auth.issue({
            accountId: native.accountIds.unrelated,
            clientId: membershipClientId,
            scopes: ['account:read', 'organization:membership'],
          });
          organizationOwner = await lifecycleAccess.authenticate(ownerCredential.bearer, {
            pool,
            deadline: Date.now() + 120_000,
          });
          principalId = newId(routeOf(actorId)!);
          const ownerReservation = await internal.reserveCoordination({
            accountId: native.accountIds.unrelated,
            relatedAccountId: principalId,
            purpose: 'membership',
            key: randomUUID(),
          });
          await internal.createOrganization({
            organizationId: principalId,
            ownerAccountId: native.accountIds.unrelated,
            ownerReservationId: ownerReservation.value.reservationId,
            key: randomUUID(),
          });
          const memberReservation = await internal.reserveCoordination({
            accountId: actorId,
            relatedAccountId: principalId,
            purpose: 'membership',
            key: randomUUID(),
          });
          await lifecycle.setMembership(ownerContext(), {
            organizationId: principalId,
            memberAccountId: actorId,
            reservationId: memberReservation.value.reservationId,
            role: 'member',
            key: randomUUID(),
          });
          await inNativeGrantBatches(posts, (id) =>
            addGroupGrant(id, { kind: 'organization', id: principalId!, role: 'member' }, [
              'post:erase',
              'post:revise',
            ]),
          );
        }
        if (mode === 'realm') {
          const realmId = (
            await pool.query<{ realm_id: string }>(
              'SELECT realm_id FROM content.board WHERE route=$1 AND board_id=$2',
              [routeOf(board.board), board.board],
            )
          ).rows[0]?.realm_id;
          if (!realmId) throw new Error('Native fixture thread has no Realm');
          principalId = realmId;
          const joined = await request(native, 'author', 'POST', `/v1/realms/${realmId}/membership`, {});
          if (joined.status !== 202) throw new Error(`Native Realm join returned ${joined.status}`);
          await until(async () => {
            const row = await pool.query(
              'SELECT 1 FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
              [realmId, actorId],
            );
            return row.rowCount ? true : undefined;
          });
          await inNativeGrantBatches(posts, async (id) => {
            await addRealmRole({ route: board.route, id }, realmId);
          });
        }
        // Group membership fixtures must not inherit the creator's direct role;
        // their only post permission comes from the native group grant below.
        if (mode === 'delegated')
          await inNativeGrantBatches(posts, async (id) => {
            await grants.create(authorContext(), {
              resource: { route: board.route, id },
              subject: { kind: 'account', id: principalId! },
              actions: ['post:erase'],
              valid: '(,)',
              key: randomUUID(),
            });
          });
        if (mode === 'organization' || mode === 'realm')
          await inNativeGrantBatches(posts, async (id) => {
            const role = (
              await pool.query<{ valid: string }>(
                `SELECT valid::text FROM access.resource_role_grant
                 WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
                   AND subject_role='' AND grant_role='content.post.owner' AND upper_inf(valid)`,
                [board.route, id, actorId],
              )
            ).rows[0];
            if (role)
              await grants.revokeRole(authorContext(), {
                resource: { route: board.route, id },
                subject: { kind: 'account', id: actorId },
                role: 'content.post.owner',
                valid: role.valid,
                key: randomUUID(),
              });
          });
        if (principalId) {
          if (mode === 'delegated') {
            await grantIfAbsent('author', {
              resource: { route: routeOf(actorId)!, id: actorId },
              subject: { kind: 'account', id: principalId },
              actions: ['account:read'],
            });
            await grantIfAbsent('governance', {
              resource: PLATFORM_RESOURCE,
              subject: { kind: 'account', id: principalId },
              actions: ['access:grant'],
            });
            const principal = await native.system.auth.issue({
              accountId: principalId,
              clientId: native.system.auth.ordinaryClient.id,
              scopes: ['access:grant'],
            });
            requestedBy = (
              await createDelegationCommands({ pool, access: native.system.access, action: 'access:grant' }).create(
                { pool, actor: principal.actor, deadline: Date.now() + 120_000 },
                {
                  principalId,
                  assignedActorId: actorId,
                  requestId: newId(routeOf(principalId)!),
                  valid: '(,)',
                  key: randomUUID(),
                },
              )
            ).value.requestedBy;
          }
        }
        await grantIfAbsent('governance', {
          resource: { route: routeOf(actorId)!, id: actorId },
          subject: { kind: 'account', id: actorId },
          actions: ['account:read'],
        });
        const outsideAction = 'moderation:takedown';
        const auth = native.system.nativeAuth;
        const handler = auth.handler.bind(auth);
        let refreshToken = '';
        auth.handler = async (input) => {
          const response = await handler(input);
          if (new URL(input.url).pathname === '/signin' && response.ok)
            refreshToken = response.headers
              .getSetCookie()
              .map((cookie) => cookie.split(';')[0])
              .join('; ');
          return response;
        };
        let credential;
        try {
          if (!externalClientId) {
            externalClientId = `durable_${randomUUID().replaceAll('-', '')}`;
            await auth.internal.registerClient({
              clientId: externalClientId,
              firstParty: false,
              scopes: [...native.system.actions.keys()].filter((action) => action !== 'media:complete').sort(),
            });
          }
          await native.system.auth.issue({
            accountId: actorId,
            clientId: native.system.auth.ordinaryClient.id,
            scopes: [...native.system.actions.keys()].filter((action) => action !== 'media:complete').sort(),
          });
          if (!refreshToken) throw new Error('Native Auth returned no consent session cookie');
          const issuer = decodeJwt(native.system.actors.author.bearer).iss;
          if (typeof issuer !== 'string') throw new Error('Native Auth credential has no issuer');
          const consentResponse = await handler(
            new Request(`${issuer}/consent`, {
              method: 'POST',
              headers: {
                origin: issuer,
                cookie: refreshToken,
                'content-type': 'application/json',
                'idempotency-key': JSON.stringify(randomUUID()),
              },
              body: JSON.stringify({
                client_id: externalClientId,
                scope: ['account:read', 'post:erase', outsideAction],
              }),
            }),
          );
          if (!consentResponse.ok)
            throw new Error(
              `Native Auth consent setup returned ${consentResponse.status}: ${await consentResponse.text()}`,
            );
          credential = await native.system.auth.issue({
            accountId: actorId,
            clientId: externalClientId,
            scopes: ['account:read', 'post:erase'],
            ...(requestedBy === undefined ? {} : { requestedBy }),
          });
        } finally {
          auth.handler = handler;
        }
        if (!refreshToken) throw new Error('Native Auth returned no renewal cookie');
        const floor = await pool.query(
          'SELECT minimum_authn_epoch::text AS floor FROM access.account WHERE account_id=$1',
          [actorId],
        );
        const claims = decodeJwt(credential.bearer);
        if (typeof claims.exp !== 'number') throw new Error('Native token has no expiry');
        const fixture: Fixture = {
          accessToken: credential.bearer,
          refreshToken,
          expiresAt: new Date(claims.exp * 1000).toISOString(),
          tuple: {
            actor: credential.actor.accountId,
            client: credential.actor.clientId,
            scopes: credential.actor.scopes,
            delegator: credential.actor.requestedBy,
            authnEpoch: credential.actor.authnEpoch,
            recordedFloor: floor.rows[0]!.floor,
          },
          principalId,
          threadId: board.thread,
          authorId: actorId,
          key: randomUUID(),
          outsideAction,
        };
        return fixture;
      },
      async create(fixture) {
        native.updateBearer('author', fixture.accessToken);
        const response = await request(
          native,
          'author',
          'POST',
          `/v1/threads/${fixture.threadId}:erase`,
          { authorId: fixture.authorId },
          fixture.key,
        );
        const wire = await response.text();
        if (response.status === 403 && JSON.parse(wire).code === 'forbidden') {
          return { outcome: 'denied' };
        }
        if (response.status !== 202) throw new Error(`Native erasure creation: ${response.status} ${wire}`);
        const id = (JSON.parse(wire) as { name: string }).name.slice('operations/'.length);
        const operation = { domain: 'content', route: routeOf(id)!, id };
        const observationDeadline = Date.now() + 60_000;
        let observation = 'operation row is missing';
        let nextStatusRead = 0;
        while (Date.now() < observationDeadline) {
          worker!.assertRunning();
          const row = await operationRow(operation);
          if (row?.native_workflow_id) {
            const gate = await pool.query(`SELECT 1 FROM ${barrierTable} WHERE workflow_id=$1 AND serial=1`, [
              row.native_workflow_id,
            ]);
            if (gate.rowCount) break;
            if (Date.now() >= nextStatusRead) {
              nextStatusRead = Date.now() + 1_000;
              const status = await client!.getWorkflow(row.native_workflow_id);
              observation = `workflow ${row.native_workflow_id} status ${status?.status ?? 'unknown'}`;
              if (status?.status === 'ERROR')
                throw new Error(`Native erasure workflow failed before its first boundary: ${JSON.stringify(status)}`);
            }
          } else if (row) observation = 'operation row has no native workflow id';
          await sleep();
        }
        const observed = await pool.query(
          `SELECT native_workflow_id FROM content.operation WHERE route=$1 AND operation_id=$2`,
          [operation.route, operation.id],
        );
        const workflowId = observed.rows[0]?.native_workflow_id as string | null | undefined;
        const firstGate = workflowId
          ? await pool.query(`SELECT 1 FROM ${barrierTable} WHERE workflow_id=$1 AND serial=1`, [workflowId])
          : undefined;
        if (!firstGate?.rowCount) throw new Error(`Native erasure did not reach its first boundary: ${observation}`);
        fixturesByOperation.set(operation.id, fixture);
        return { outcome: 'committed', operation };
      },
      async inspect(operation) {
        const row = await operationRow(operation);
        const fixture = fixturesByOperation.get(operation.id);
        if (!fixture) throw new Error('Operation fixture is missing');
        const workflowKey = `wf:${operation.id}:%`;
        const receiptRows = (
          await pool.query(
            `SELECT * FROM core.receipt
             WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
               AND ((command_kind='content.author-erasure' AND idempotency_key=$3)
                 OR (command_kind IN ('content.author-erasure.page', 'content.author-erasure.cleanup')
                   AND idempotency_key LIKE $4))
             ORDER BY command_kind, idempotency_key`,
            [partitionOf(operation.route), fixture.tuple.actor, fixture.key, workflowKey],
          )
        ).rows;
        const events = (
          await pool.query(
            `SELECT to_jsonb(event) AS value
             FROM core.outbox event
             JOIN core.receipt receipt
               ON receipt.partition_no=event.partition_no
              AND receipt.epoch=event.epoch
              AND receipt.position=event.position
             WHERE receipt.partition_no=$1 AND receipt.principal_kind='account' AND receipt.principal_id=$2
               AND ((receipt.command_kind='content.author-erasure' AND receipt.idempotency_key=$3)
                 OR (receipt.command_kind IN ('content.author-erasure.page', 'content.author-erasure.cleanup')
                   AND receipt.idempotency_key LIKE $4))
             ORDER BY event.partition_no, event.epoch, event.position, event.event_seq`,
            [partitionOf(operation.route), fixture.tuple.actor, fixture.key, workflowKey],
          )
        ).rows.map((item) => item.value);
        const cleanupReceipts = receiptRows.filter(
          (value: Record<string, unknown>) => value.command_kind === 'content.author-erasure.cleanup',
        );
        const cleanupTransactions = cleanupReceipts.map((item: Record<string, unknown>) => item.transaction_id);
        const cleanupEvents = cleanupTransactions.length
          ? (
              await pool.query(
                `SELECT to_jsonb(event) AS value
                 FROM core.outbox event
                 JOIN core.receipt receipt
                   ON receipt.partition_no=event.partition_no
                  AND receipt.epoch=event.epoch
                  AND receipt.position=event.position
                 WHERE receipt.transaction_id=ANY($1::uuid[])
                 ORDER BY to_jsonb(event)::text`,
                [cleanupTransactions],
              )
            ).rows.map((item) => item.value)
          : [];
        const cleanupEventIds = new Set(
          cleanupEvents.map((value: Record<string, unknown>) =>
            JSON.stringify([value.partition_no, value.epoch, value.position, value.event_seq]),
          ),
        );
        const cleanupPostIds = (
          await pool.query<{ post_ids: string[] }>(
            `SELECT DISTINCT jsonb_array_elements_text(response->'postIds') AS post_ids
             FROM core.receipt
             WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
               AND command_kind='content.author-erasure.page' AND idempotency_key LIKE $3
               AND response ? 'postIds'
             ORDER BY post_ids`,
            [partitionOf(operation.route), fixture.tuple.actor, `wf:${operation.id}:erase:%`],
          )
        ).rows.map((item) => item.post_ids);
        const cleanupResources =
          cleanupReceipts.length && cleanupPostIds.length
            ? (
                await Promise.all([
                  pool.query(
                    `SELECT to_jsonb(t) AS value FROM content.revision t
                   WHERE route=$1 AND post_id=ANY($2::uuid[]) ORDER BY to_jsonb(t)::text`,
                    [operation.route, cleanupPostIds],
                  ),
                  pool.query(
                    `SELECT to_jsonb(m) AS value FROM content.media m
                   WHERE m.route=$1 AND EXISTS (
                     SELECT 1 FROM content.revision r
                     WHERE r.route=m.route AND r.post_id=ANY($2::uuid[]) AND m.media_id=ANY(r.media_ids)
                   ) ORDER BY to_jsonb(m)::text`,
                    [operation.route, cleanupPostIds],
                  ),
                ])
              ).flatMap((result) => result.rows.map((item) => item.value))
            : [];
        const cleanup = [
          ...cleanupReceipts.map((value: unknown) => ({ source: 'receipt', value })),
          ...cleanupEvents.map((value: unknown) => ({ source: 'outbox', value })),
          ...cleanupResources.map((value: unknown) => ({ source: 'resource', value })),
        ];
        const receipt = receiptRows.find(
          (value: Record<string, unknown>) =>
            value.command_kind === 'content.author-erasure' && value.idempotency_key === fixture.key,
        );
        const durableRecords: Snapshot['durableRecords'] = [];
        if (row) durableRecords.push({ source: 'operation', value: row });
        for (const value of receiptRows) durableRecords.push({ source: 'receipt', value });
        for (const value of events) durableRecords.push({ source: 'event', value });
        if (row?.native_workflow_id) {
          for (const [table, source] of [
            ['dbos.workflow_input', 'dbos-input'],
            ['dbos.operation_outputs', 'dbos-checkpoint'],
            ['dbos.workflow_output', 'dbos-result'],
          ] as const) {
            for (const value of (
              await pool.query(`SELECT * FROM ${table} WHERE workflow_uuid=$1`, [row.native_workflow_id])
            ).rows)
              durableRecords.push({ source, value });
          }
        }
        return {
          operation: row
            ? {
                anchor: operation,
                kind: 'content.author_erasure',
                purpose: row.creation_command_kind,
                key: row.creation_idempotency_key,
                digest: row.creation_request_digest,
                tuple: {
                  actor: row.actor_account_id,
                  client: row.actor_client_id,
                  scopes: row.actor_scopes,
                  delegator: row.actor_requested_by,
                  authnEpoch: Number(row.actor_authn_epoch),
                  recordedFloor: row.original_minimum_authn_epoch,
                },
                target: { threadId: row.thread_id, authorId: row.author_account_id },
                transactionId: row.recorded_transaction_id,
                workflowId: row.native_workflow_id,
                source: {
                  epoch: row.source_epoch,
                  partition: row.source_partition,
                  position: String(row.source_position),
                  eventIndex: row.source_event_index,
                },
              }
            : null,
          creationReceipt: receipt
            ? {
                id: JSON.stringify([
                  receipt.partition_no,
                  receipt.principal_kind,
                  receipt.principal_id,
                  receipt.command_kind,
                  receipt.idempotency_key,
                ]),
                transactionId: receipt.transaction_id,
                key: receipt.idempotency_key,
                digest: Buffer.from(receipt.request_digest).toString('hex'),
                operation,
              }
            : null,
          cleanup,
          protected: {
            receipts: receiptRows.filter(
              (value: Record<string, unknown>) => value.command_kind !== 'content.author-erasure.cleanup',
            ),
            effects: events.filter(
              (value: Record<string, unknown>) =>
                !cleanupEventIds.has(
                  JSON.stringify([value.partition_no, value.epoch, value.position, value.event_seq]),
                ),
            ),
            outbox: events.filter(
              (value: Record<string, unknown>) =>
                !cleanupEventIds.has(
                  JSON.stringify([value.partition_no, value.epoch, value.position, value.event_seq]),
                ),
            ),
            resources: (
              await Promise.all([
                pool.query(`SELECT to_jsonb(t) AS value FROM content.thread t WHERE route=$1 AND thread_id=$2`, [
                  routeOf(fixture.threadId),
                  fixture.threadId,
                ]),
                pool.query(
                  `SELECT to_jsonb(t) AS value FROM content.post t WHERE route=$1 AND thread_id=$2
                   ORDER BY post_id`,
                  [routeOf(fixture.threadId), fixture.threadId],
                ),
                pool.query(`SELECT to_jsonb(t) AS value FROM content.operation t WHERE route=$1 AND operation_id=$2`, [
                  operation.route,
                  operation.id,
                ]),
              ])
            ).flatMap((result) => result.rows.map((item) => item.value)),
          },
          durableRecords,
        };
      },
      async points(operation) {
        const row = await operationRow(operation);
        if (!row?.native_workflow_id) throw new Error('Operation has no native workflow binding');
        // Consult the actual SDK registry and native worker barriers. Future
        // invocations are not fabricated from a duplicate orchestration loop.
        const registry = await client!.listWorkflowSteps(row.native_workflow_id);
        const pages =
          registry
            ?.map((step) => step.output)
            .filter(
              (output): output is { post_id: string }[] =>
                Array.isArray(output) && typeof output[0]?.post_id === 'string',
            ) ?? [];
        const gates = await pool.query(`SELECT name FROM ${barrierTable} WHERE workflow_id=$1 ORDER BY serial`, [
          row.native_workflow_id,
        ]);
        const points: Point[] = gates.rows.map((gate, index) => {
          const first = pages[index]?.[0];
          if (!first) throw new Error('Native protected checkpoint has no committed page read');
          return {
            id: gate.name,
            kind: 'step',
            action: 'post:erase',
            resource: { route: operation.route, id: first.post_id },
            purpose: row.creation_command_kind,
          };
        });
        for (const kind of ['result', 'cached-result'] as const)
          points.push({
            id: kind,
            kind,
            action: 'account:read',
            resource: { route: routeOf(row.actor_account_id)!, id: row.actor_account_id },
            purpose: row.creation_command_kind,
          });
        return points;
      },
      async park(operation, pointId) {
        for (;;) {
          const points = await this.points(operation);
          const row = await operationRow(operation);
          const gates = await pool.query(
            `SELECT name,attempt FROM ${barrierTable} WHERE workflow_id=$1 ORDER BY serial`,
            [row!.native_workflow_id],
          );
          const pending = gates.rows.find((gate) => gate.attempt === null);
          if (pending?.name === pointId) {
            const target = points.find((point) => point.id === pointId);
            if (target) parked = { operation, point: target };
            return;
          }
          if (!pending) {
            const target = points.find((point) => point.id === pointId);
            if (target && target.kind !== 'step') {
              parked = { operation, point: target };
              return;
            }
            throw new Error(`No native pending checkpoint ${pointId}`);
          }
          await this.advance(operation, pending.name);
          const target = points.find((point) => point.id === pointId);
          if (target?.kind === 'step') {
            const current = await pool.query(`SELECT attempt FROM ${barrierTable} WHERE workflow_id=$1 AND name=$2`, [
              row!.native_workflow_id,
              pointId,
            ]);
            if (current.rows[0]?.attempt === null) {
              parked = { operation, point: target };
              return;
            }
          }
        }
      },
      async advance(operation, pointId) {
        const row = await operationRow(operation);
        const workflow = row!.native_workflow_id;
        if (pointId === 'result' || pointId === 'cached-result') return worker!.replay(operation.id, pointId);
        const gate = (
          await pool.query(`SELECT serial,name FROM ${barrierTable} WHERE workflow_id=$1 AND name=$2`, [
            workflow,
            pointId,
          ])
        ).rows[0];
        if (!gate) throw new Error(`Unknown native step checkpoint ${pointId}`);
        await pool.query(`UPDATE ${barrierTable} SET released=true WHERE workflow_id=$1 AND serial=$2`, [
          workflow,
          gate.serial,
        ]);
        const completed = await until(async () => {
          const current = (
            await pool.query(`SELECT attempt,error FROM ${barrierTable} WHERE workflow_id=$1 AND serial=$2`, [
              workflow,
              gate.serial,
            ])
          ).rows[0];
          if (current?.error) throw new Error(current.error);
          return current?.attempt ?? undefined;
        });
        const reached = await until(async () => {
          const next = await pool.query(`SELECT 1 FROM ${barrierTable} WHERE workflow_id=$1 AND serial=$2`, [
            workflow,
            gate.serial + 1,
          ]);
          const status = await client!.getWorkflow(workflow);
          return next.rowCount ? 'next' : status && ['SUCCESS', 'ERROR'].includes(status.status) ? 'done' : undefined;
        });
        if (reached === 'next') pendingAdvances.set(operation.id, operation);
        else pendingAdvances.delete(operation.id);
        return decodeAttempt(completed as Attempt);
      },
      async mutate(fixture, mutation) {
        const target =
          parked && fixturesByOperation.get(parked.operation.id)?.threadId === fixture.threadId ? parked : undefined;
        if (!target && mutation !== 'actor-grant' && mutation !== 'principal-grant')
          throw new Error('Mutation requires the native point currently parked for this fixture');
        let grantOperation = target?.operation;
        if (!grantOperation && (mutation === 'actor-grant' || mutation === 'principal-grant')) {
          const row = (
            await pool.query<{ operation_id: string }>(
              'SELECT operation_id FROM content.operation WHERE route=$1 AND thread_id=$2 AND actor_account_id=$3',
              [routeOf(fixture.threadId), fixture.threadId, fixture.tuple.actor],
            )
          ).rows[0];
          if (row) grantOperation = { domain: 'content', route: routeOf(fixture.threadId)!, id: row.operation_id };
        }
        if (!grantOperation) throw new Error('Native grant mutation has no operation anchor');
        const operation = await operationRow(grantOperation);
        if (!operation || operation.thread_id !== fixture.threadId)
          throw new Error('Mutation fixture does not match the parked native operation');
        const deadline = Date.now() + 120_000;
        const postId =
          target?.point.action === 'post:erase'
            ? target.point.resource.id
            : (operation.anchor_post_id as string | undefined);
        if (!postId) throw new Error('Native operation has no selected post');
        const action = target?.point.action ?? 'post:erase';
        const resource =
          action === 'account:read'
            ? { route: routeOf(fixture.tuple.actor)!, id: fixture.tuple.actor }
            : {
                route: target?.point.resource.route ?? grantOperation.route,
                id: postId,
              };
        const commands = createGrantCommands({ pool, access: native.system.access, managementAction: 'access:grant' });
        const lifecycleAccess = createLifecycleAccess(native);
        const lifecycle = createLifecycleCommands({ pool, access: lifecycleAccess });
        const internals = createLifecycleInternals({
          pool,
          routeKey: native.system.routeKey,
          provisioningEvidence: async () => null,
          recoveryEvidence: async () => null,
        });
        const changedAt = async (transactionId: string) => committedAt(transactionId);

        if (mutation === 'actor-grant' || mutation === 'principal-grant') {
          const subjectId = mutation === 'actor-grant' ? fixture.tuple.actor : fixture.principalId;
          if (subjectId === null) throw new Error('Fixture has no principal');
          const permissionAction = action === 'account:read' ? 'account:read' : 'post:erase';
          const grantResource = resource;
          const grantor = await freshAuthorActor(deadline);
          if (mutation === 'actor-grant' && permissionAction === 'post:erase') {
            const role = (
              await pool.query<{ valid: string }>(
                `SELECT valid::text FROM access.resource_role_grant
                 WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
                   AND subject_role='' AND grant_role='content.post.owner' AND upper_inf(valid)`,
                [grantResource.route, grantResource.id, subjectId],
              )
            ).rows[0];
            if (role) {
              const outcome = await commands.revokeRole(
                { pool, actor: grantor, deadline },
                {
                  resource: grantResource,
                  subject: { kind: 'account', id: subjectId },
                  role: 'content.post.owner',
                  valid: role.valid,
                  key: randomUUID(),
                },
              );
              return changedAt(outcome.transactionId);
            }
          }
          const row = (
            await pool.query<{ valid: string }>(
              `SELECT valid::text FROM access.resource_grant
               WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
                 AND subject_role='' AND action=$4 AND upper_inf(valid)`,
              [grantResource.route, grantResource.id, subjectId, permissionAction],
            )
          ).rows[0];
          if (!row) throw new Error(`Native ${permissionAction} grant is missing for ${mutation}`);
          const outcome = await commands.revoke(
            { pool, actor: grantor, deadline },
            {
              resource: grantResource,
              subject: { kind: 'account', id: subjectId },
              actions: [permissionAction],
              valid: row.valid,
              key: randomUUID(),
            },
          );
          return changedAt(outcome.transactionId);
        }

        if (mutation === 'suspended') {
          fixtureDirty = true;
          const governance = await freshGovernanceActor(deadline);
          const outcome = await createSuspensionCommands({
            pool,
            access: native.system.access,
            clock: () => new Date(),
          }).suspend(
            { pool, actor: governance, deadline },
            { accountId: fixture.tuple.actor, key: randomUUID(), reason: 'Durable initiator test suspension' },
          );
          return changedAt(outcome.transactionId);
        }
        if (mutation === 'tombstoned') {
          fixtureDirty = true;
          if (!lifecycleClientId) {
            lifecycleClientId = `lifecycle_${randomUUID().replaceAll('-', '')}`;
            await native.system.nativeAuth.internal.registerClient({
              clientId: lifecycleClientId,
              firstParty: true,
              scopes: [...LIFECYCLE_ACTIONS.keys()],
            });
          }
          const credential = await native.system.auth.issue({
            accountId: fixture.tuple.actor,
            clientId: lifecycleClientId,
            scopes: ['account:read', 'account:delete'],
          });
          const lifecycleActor = await lifecycleAccess.authenticate(credential.bearer, { pool, deadline });
          const outcome = await lifecycle.tombstone(
            { actor: lifecycleActor, deadline },
            {
              accountId: fixture.tuple.actor,
              key: randomUUID(),
            },
          );
          return changedAt(outcome.transactionId);
        }
        if (mutation === 'fenced' || mutation === 'epoch-floor-increased') {
          fixtureDirty = true;
          const outcome = await internals.raiseFence({ accountId: fixture.tuple.actor, key: randomUUID() });
          return changedAt(outcome.transactionId);
        }
        if (mutation === 'organization-membership') {
          const organizationId = fixture.principalId;
          if (!organizationId) throw new Error('Organization fixture has no principal');
          if (!membershipClientId) throw new Error('Native organization membership client is unavailable');
          const ownerCredential = await native.system.auth.issue({
            accountId: native.accountIds.unrelated,
            clientId: membershipClientId,
            scopes: ['account:read', 'organization:membership'],
          });
          const organizationOwner = await lifecycleAccess.authenticate(ownerCredential.bearer, { pool, deadline });
          const member = (
            await pool.query<{ reservation_id: string }>(
              `SELECT reservation_id FROM access.membership_inverse
               WHERE account_id=$1 AND kind='organization' AND group_id=$2 ORDER BY reservation_id LIMIT 1`,
              [fixture.tuple.actor, organizationId],
            )
          ).rows[0];
          if (!member) throw new Error('Native organization membership is missing');
          const outcome = await lifecycle.setMembership(
            { actor: organizationOwner, deadline },
            {
              organizationId,
              memberAccountId: fixture.tuple.actor,
              reservationId: member.reservation_id,
              role: null,
              key: randomUUID(),
            },
          );
          return changedAt(outcome.transactionId);
        }
        if (mutation === 'realm-membership') {
          const realmId = fixture.principalId;
          if (!realmId) throw new Error('Realm fixture has no principal');
          const member = (
            await pool.query<{ reservation_id: string }>(
              `SELECT reservation_id FROM community.realm_member
               WHERE route=$1 AND realm_id=$2 AND account_id=$3 AND upper_inf(valid)`,
              [routeOf(realmId), realmId, fixture.tuple.actor],
            )
          ).rows[0];
          if (!member) throw new Error('Native Realm membership is missing');
          const response = await request(native, 'author', 'DELETE', `/v1/realms/${realmId}/membership`);
          if (response.status !== 202) throw new Error(`Native Realm leave returned ${response.status}`);
          await until(async () => {
            const current = await pool.query(
              'SELECT 1 FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
              [realmId, fixture.tuple.actor],
            );
            return current.rowCount ? undefined : true;
          });
          const terminal = await pool.query<{ transaction_id: string }>(
            `SELECT transaction_id FROM community.realm_member_terminal
             WHERE route=$1 AND realm_id=$2 AND account_id=$3 AND reservation_id=$4`,
            [routeOf(realmId), realmId, fixture.tuple.actor, member.reservation_id],
          );
          if (!terminal.rows[0]) throw new Error('Native Realm leave has no terminal transaction');
          return changedAt(terminal.rows[0].transaction_id);
        }
        if (mutation === 'realm-block') {
          const realmId = fixture.principalId;
          if (!realmId) throw new Error('Realm fixture has no principal');
          const ownerCredential = await native.system.auth.issue({
            accountId: native.accountIds.unrelated,
            clientId: native.system.auth.ordinaryClient.id,
            scopes: [...native.system.actions.keys()].filter((action) => action !== 'media:complete'),
          });
          native.updateBearer('unrelated', ownerCredential.bearer);
          const response = await request(
            native,
            'unrelated',
            'PUT',
            `/v1/realms/${realmId}/bans/${fixture.tuple.actor}`,
            { reason: 'Durable initiator test ban' },
          );
          if (response.status !== 200) throw new Error(`Native Realm ban returned ${response.status}`);
          await until(async () => {
            const current = await pool.query(
              'SELECT 1 FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
              [realmId, fixture.tuple.actor],
            );
            return current.rowCount ? undefined : true;
          });
          const ban = await pool.query<{ transaction_id: string }>(
            `SELECT transaction_id FROM community.realm_ban
             WHERE route=$1 AND realm_id=$2 AND account_id=$3 AND upper_inf(valid)`,
            [routeOf(realmId), realmId, fixture.tuple.actor],
          );
          if (!ban.rows[0]) throw new Error('Native Realm ban has no committed transition');
          return changedAt(ban.rows[0].transaction_id);
        }

        if (mutation.startsWith('consent-')) {
          if (!externalClientId) throw new Error('Native Auth client is unavailable');
          const consentRow = (
            await native.system.database.authPool.query<{ scopes: string[] }>(
              'SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2',
              [fixture.tuple.actor, fixture.tuple.client],
            )
          ).rows[0];
          if (!consentRow) throw new Error('Native Auth consent is missing before mutation');
          const restoreConsent = async () => {
            const auth = native.system.nativeAuth;
            const handler = auth.handler.bind(auth);
            let cookie = '';
            auth.handler = async (input) => {
              const response = await handler(input);
              if (new URL(input.url).pathname === '/signin' && response.ok)
                cookie = response.headers
                  .getSetCookie()
                  .map((value) => value.split(';')[0])
                  .join('; ');
              return response;
            };
            try {
              await native.system.auth.issue({
                accountId: fixture.tuple.actor,
                clientId: native.system.auth.ordinaryClient.id,
                scopes: [...native.system.actions.keys()].filter((action) => action !== 'media:complete'),
              });
            } finally {
              auth.handler = handler;
            }
            if (!cookie) throw new Error('Native Auth did not issue a consent restoration session');
            const issuer = String(decodeJwt(fixture.accessToken).iss);
            const response = await handler(
              new Request(`${issuer}/consent`, {
                method: 'POST',
                headers: {
                  origin: issuer,
                  cookie,
                  'content-type': 'application/json',
                  'idempotency-key': JSON.stringify(randomUUID()),
                },
                body: JSON.stringify({ client_id: fixture.tuple.client, scope: consentRow.scopes }),
              }),
            );
            if (!response.ok) throw new Error(`Native Auth consent restoration returned ${response.status}`);
          };
          restoreMutation = restoreConsent;
          if (mutation === 'consent-missing') {
            await native.system.database.authPool.query(
              'DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2',
              [fixture.tuple.actor, fixture.tuple.client],
            );
            return (await native.system.database.authPool.query('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
          }
          const consent = mutation === 'consent-revoked' ? [] : ['account:read'];
          const issuer = String(decodeJwt(fixture.accessToken).iss);
          const response = await native.system.nativeAuth.handler(
            new Request(`${issuer}/consent`, {
              method: 'POST',
              headers: {
                origin: issuer,
                cookie: fixture.refreshToken,
                'content-type': 'application/json',
                'idempotency-key': JSON.stringify(randomUUID()),
              },
              body: JSON.stringify({ client_id: fixture.tuple.client, scope: consent }),
            }),
          );
          if (!response.ok) throw new Error(`Native Auth consent mutation returned ${response.status}`);
          const account = await pool.query<{ transaction_id: string }>(
            'SELECT transaction_id FROM access.account WHERE account_id=$1',
            [fixture.tuple.actor],
          );
          if (!account.rows[0]) throw new Error('Native Auth consent mutation has no account transition');
          return changedAt(account.rows[0].transaction_id);
        }
        if (mutation === 'client-missing') {
          fixtureDirty = true;
          return isolatedFault(native.system.database.authPool, async (connection) => {
            await connection.query('DELETE FROM auth_client WHERE client_id=$1', [fixture.tuple.client]);
          });
        }
        if (mutation.startsWith('delegation-')) {
          const match = /^urn:rezics:request:([^:]+):([^:]+)$/.exec(fixture.tuple.delegator ?? '');
          if (!match) throw new Error('Delegated fixture has no native assignment reference');
          const principalId = match[1]!;
          const requestId = match[2]!;
          if (mutation === 'delegation-revoked') {
            const principal = await native.system.auth.issue({
              accountId: principalId,
              clientId: native.system.auth.ordinaryClient.id,
              scopes: ['access:grant'],
            });
            const principalActor = await native.system.access.authenticate(principal.bearer, { pool, deadline });
            const outcome = await createDelegationCommands({
              pool,
              access: native.system.access,
              action: 'access:grant',
            }).revoke({ pool, actor: principalActor, deadline }, { principalId, requestId, key: randomUUID() });
            return changedAt(outcome.transactionId);
          }
          return isolatedFault(pool, async (connection) => {
            if (mutation === 'delegation-missing')
              await connection.query(
                'DELETE FROM access.principal_assignment WHERE principal_id=$1 AND request_id=$2',
                [principalId, requestId],
              );
            else if (mutation === 'delegation-changed-actor')
              await connection.query(
                'UPDATE access.principal_assignment SET assigned_actor_id=$3 WHERE principal_id=$1 AND request_id=$2',
                [principalId, requestId, newId(routeOf(fixture.tuple.actor)!)],
              );
            else
              await connection.query(
                'UPDATE access.principal_assignment SET principal_id=$3 WHERE principal_id=$1 AND request_id=$2',
                [principalId, requestId, newId(routeOf(principalId)!)],
              );
          });
        }
        if (mutation === 'account-missing') {
          fixtureDirty = true;
          return isolatedFault(pool, async (connection) => {
            await connection.query('DELETE FROM access.account WHERE account_id=$1', [fixture.tuple.actor]);
          });
        }
        throw new Error(`Unknown native mutation ${mutation}`);
      },
      async grant(fixture, mode) {
        const operation = (
          await pool.query<{ operation_id: string; route: number; anchor_post_id: string }>(
            `SELECT operation_id,route,anchor_post_id FROM content.operation
             WHERE thread_id=$1 AND actor_account_id=$2`,
            [fixture.threadId, fixture.tuple.actor],
          )
        ).rows[0];
        if (!operation) throw new Error('Native grant fixture has no author-erasure operation');
        const currentPoint = parked?.operation.id === operation.operation_id ? parked.point : undefined;
        const resource =
          mode === 'restore-actor' && currentPoint?.action === 'post:erase'
            ? currentPoint.resource
            : { route: operation.route, id: operation.anchor_post_id };
        const deadline = Date.now() + 120_000;
        const author = await freshAuthorActor(deadline);
        await createGrantCommands({ pool, access: native.system.access, managementAction: 'access:grant' }).create(
          { pool, actor: author, deadline },
          {
            resource,
            subject: { kind: 'account', id: fixture.tuple.actor },
            actions: [mode === 'restore-actor' ? 'post:erase' : fixture.outsideAction],
            valid: '(,)',
            key: randomUUID(),
          },
        );
      },
      async attack(operation, pointId, attack, _input) {
        if (pointId === 'result' || pointId === 'cached-result')
          throw new Error('The frozen provenance attacks target native step checkpoints');
        const original = (
          await pool.query<{ value: Record<string, unknown> }>(
            'SELECT to_jsonb(t) AS value FROM content.operation t WHERE route=$1 AND operation_id=$2',
            [operation.route, operation.id],
          )
        ).rows[0]?.value;
        if (!original) throw new Error('Native operation row is missing before fault injection');
        const point = (await this.points(operation)).find((value) => value.id === pointId);
        if (!point) throw new Error(`Native checkpoint ${pointId} is not registered`);

        // First exercise the native immutable row boundary. The adversarial read
        // below still runs even when that write is rejected by the product.
        let immutableRejected = false;
        try {
          await pool.query('UPDATE content.operation SET source_digest=$3 WHERE route=$1 AND operation_id=$2', [
            operation.route,
            operation.id,
            createHash('sha256').update(`native-attack:${attack}:${randomUUID()}`).digest('hex'),
          ]);
        } catch {
          immutableRejected = true;
        }
        if (!immutableRejected) {
          await isolatedFault(pool, async (connection) => {
            await connection.query('UPDATE content.operation SET source_digest=$3 WHERE route=$1 AND operation_id=$2', [
              operation.route,
              operation.id,
              original.source_digest,
            ]);
          });
          throw new Error('Native operation identity unexpectedly accepted an immutable update');
        }

        if (attack === 'changed-source') {
          await isolatedFault(pool, async (connection) => {
            await connection.query('UPDATE content.operation SET source_digest=$3 WHERE route=$1 AND operation_id=$2', [
              operation.route,
              operation.id,
              createHash('sha256').update(`changed-source:${randomUUID()}`).digest('hex'),
            ]);
          });
          try {
            return await worker!.probe(operation.id, point, attack, _input);
          } finally {
            await isolatedFault(pool, async (connection) => {
              await connection.query(
                'UPDATE content.operation SET source_digest=$3 WHERE route=$1 AND operation_id=$2',
                [operation.route, operation.id, original.source_digest],
              );
            });
          }
        }

        if (attack === 'originally-stale-tuple' || attack === 'refresh-stale-floor') {
          const actorAccountId = original.actor_account_id as string;
          const fixtureRow = await pool.query<{ minimum_authn_epoch: string }>(
            'SELECT minimum_authn_epoch::text FROM access.account WHERE account_id=$1',
            [actorAccountId],
          );
          const floor = fixtureRow.rows[0]?.minimum_authn_epoch;
          if (!floor) throw new Error('Stale evidence attack has no current account floor');
          const staleFloor = (BigInt(floor) + 1n).toString();
          await isolatedFault(pool, async (connection) => {
            await connection.query(
              'UPDATE access.account SET minimum_authn_epoch=$3 WHERE route=$1 AND account_id=$2',
              [routeOf(actorAccountId)!, actorAccountId, staleFloor],
            );
          });
          try {
            const fixture = fixturesByOperation.get(operation.id);
            if (!fixture) throw new Error('Stale evidence attack has no authenticated fixture');
            native.updateBearer('author', fixture.accessToken);
            const refusal = await request(
              native,
              'author',
              'POST',
              `/v1/threads/${fixture.threadId}:erase`,
              { authorId: fixture.authorId },
              randomUUID(),
            );
            if (refusal.status !== 403)
              throw new Error(`Native create with stale authenticated evidence returned ${refusal.status}`);
            return await worker!.probe(operation.id, point, attack, _input);
          } finally {
            await isolatedFault(pool, async (connection) => {
              await connection.query(
                'UPDATE access.account SET minimum_authn_epoch=$3 WHERE route=$1 AND account_id=$2',
                [routeOf(actorAccountId)!, actorAccountId, floor],
              );
            });
          }
        }

        if (attack === 'missing-receipt' || attack === 'uncommitted-receipt' || attack === 'rolled-back-create') {
          const receipt = (
            await pool.query<Record<string, unknown>>(
              `SELECT * FROM core.receipt
               WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
                 AND command_kind=$3 AND idempotency_key=$4`,
              [
                partitionOf(operation.route),
                original.initiator_account_id,
                original.creation_command_kind,
                original.creation_idempotency_key,
              ],
            )
          ).rows[0];
          if (!receipt) return worker!.probe(operation.id, point, attack, _input);
          // Receipt deletion has no product command. Keep it isolated as a
          // storage fault after the immutable operation write above was tried.
          await isolatedFault(pool, async (connection) => {
            await connection.query(
              `DELETE FROM core.receipt
               WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
                 AND command_kind=$3 AND idempotency_key=$4`,
              [
                partitionOf(operation.route),
                original.initiator_account_id,
                original.creation_command_kind,
                original.creation_idempotency_key,
              ],
            );
          });
          try {
            return await worker!.probe(operation.id, point, attack, _input);
          } finally {
            const insertable = Object.entries(receipt).filter(([column]) => column !== 'actor_account_id');
            const columns = insertable
              .map(([column]) => column)
              .map((column) => `"${column.replaceAll('"', '""')}"`)
              .join(',');
            const placeholders = insertable.map((_, index) => `$${index + 1}`).join(',');
            await isolatedFault(pool, async (connection) => {
              await connection.query(
                `INSERT INTO core.receipt (${columns}) VALUES (${placeholders})`,
                insertable.map(([, value]) => value),
              );
            });
          }
        }

        return worker!.probe(operation.id, point, attack, _input);
      },
      async restart() {
        await worker?.stop();
        worker = undefined;
        await client?.close();
        client = await createWorkClient(native.appUrl);
        worker = await startWorker(native, executorId);
        if (trustedClock) await worker.setClock(trustedClock);
        parked = undefined;
      },
      async passOriginalExpiry(fixture) {
        trustedClock = isoAfter(fixture.expiresAt, 300_001);
        await worker!.setClock(trustedClock);
      },
      async readPublic(operation) {
        return worker!.publicRead(operation.id);
      },
      async authority(fixture) {
        const account = await readAccount(pool, routeOf(fixture.tuple.actor)!, fixture.tuple.actor);
        const { readCurrentConsent } = createCurrentConsentReader({ database: native.system.database.authPool });
        const consent = await readCurrentConsent({
          actorAccountId: fixture.tuple.actor,
          clientId: fixture.tuple.client,
        });
        const client = await native.system.database.authPool.query('SELECT 1 FROM auth_client WHERE client_id=$1', [
          fixture.tuple.client,
        ]);
        const grants = async (id: string | null) =>
          id === null
            ? []
            : (
                await pool.query(
                  `SELECT to_jsonb(t) AS value FROM access.resource_grant t WHERE subject_id=$1 UNION ALL SELECT to_jsonb(t) FROM access.resource_role_grant t WHERE subject_id=$1 ORDER BY value`,
                  [id],
                )
              ).rows.map((row) => row.value);
        const assignment = fixture.tuple.delegator?.split(':');
        const delegation = assignment
          ? ((
              await pool.query(
                'SELECT to_jsonb(t) AS value FROM access.principal_assignment t WHERE principal_id=$1 AND request_id=$2',
                [assignment[3], assignment[4]],
              )
            ).rows[0]?.value ?? null)
          : null;
        return {
          state: account?.state ?? 'missing',
          fenced: account?.fenced ?? false,
          floor: account?.minimumAuthnEpoch.toString() ?? '0',
          clientExists: client.rowCount === 1,
          consentScopes: consent ? [...consent.scopes] : null,
          delegation,
          actorGrants: await grants(fixture.tuple.actor),
          principalGrants: await grants(fixture.principalId),
          memberships: (
            await pool.query(
              `SELECT 'organization' AS kind,to_jsonb(t) AS value FROM access.organization_member t
               WHERE member_account_id=$1 AND upper_inf(valid)
               UNION ALL
               SELECT 'realm' AS kind,to_jsonb(t) AS value FROM community.realm_member t
               WHERE account_id=$1 AND upper_inf(valid)
               ORDER BY kind,value`,
              [fixture.tuple.actor],
            )
          ).rows,
          blocks: (
            await pool.query(
              'SELECT to_jsonb(t) AS value FROM community.realm_ban t WHERE account_id=$1 ORDER BY to_jsonb(t)::text',
              [fixture.tuple.actor],
            )
          ).rows.map((row) => row.value),
        };
      },
    };
    drainPending = async () => {
      const operations = new Map(pendingAdvances);
      if (parked?.point.kind === 'step') operations.set(parked.operation.id, parked.operation);
      for (const operation of operations.values()) {
        for (;;) {
          const row = await operationRow(operation);
          if (!row?.native_workflow_id) break;
          const pending = (
            await pool.query<{ name: string }>(
              `SELECT name FROM ${barrierTable} WHERE workflow_id=$1 AND attempt IS NULL ORDER BY serial LIMIT 1`,
              [row.native_workflow_id],
            )
          ).rows[0];
          if (!pending) break;
          await driver.advance(operation, pending.name);
        }
      }
      pendingAdvances.clear();
      parked = undefined;
    };
    return driver;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Durable initiator setup and cleanup failed');
    }
    throw error;
  }
}

/** Run the product registration in a separate, disposable DBOS host. The wrapper
 * observes the registered step; the registered function still owns every write.
 */
async function runWorker() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const [line] = (await once(input, 'line')) as [string];
  const config = JSON.parse(line.slice('config '.length)) as {
    databaseUrl: string;
    authDatabaseUrl: string;
    routeKey: string;
    executorId: string;
    actions: [string, { anonymous: boolean; replay?: 'self-account-read'; 'x-resource-types'?: readonly string[] }][];
  };
  const pool = new Pool({ connectionString: config.databaseUrl, max: 12 });
  const barriers = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const authPool = new Pool({ connectionString: config.authDatabaseUrl });
  const consent = createCurrentConsentReader({ database: authPool });
  const traces = new AsyncLocalStorage<Attempt>();
  let workerInstant: number | undefined;
  const clock = () => new Date(workerInstant ?? Date.now());
  const membershipConfig = readMembershipWorkConfig(process.env);
  const actionCatalogue = new Map([...LIFECYCLE_ACTIONS, ...config.actions]);
  let realmMembership: ReturnType<typeof createRealmMembership> | undefined;
  const access = createAccess({
    actions: actionCatalogue,
    auth: membershipConfig.auth,
    realmRoleReader: (client, membership) => {
      if (!realmMembership) throw new Error('Realm membership role reader is not installed');
      return realmMembership.roleReader(client, membership);
    },
    clock,
  });
  const readConsent = ({ actorAccountId, clientId }: { actorAccountId: string; clientId: string }) =>
    consent.readCurrentConsent({ actorAccountId, clientId });
  const restorer = createInitiatorRestorer({
    pool,
    access,
    readOperation: async (client, operation, time) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const record = await readErasureInitiator(client, operation, time);
        await client.query('COMMIT');
        return record;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
    readConsent,
  });
  const resourceKey = (action: string, resource: Pick<Resource, 'route' | 'id'>) =>
    JSON.stringify([action, resource.route, resource.id]);
  const publicResources = new WeakMap<Attempt, Map<string, Resource>>();
  const restoredActors = new WeakMap<Attempt, Map<string, AccountActor>>();
  realmMembership = createRealmMembership({
    pool,
    access,
    referenceKeys: membershipConfig.referenceKeys,
    clock,
    restorer: createInitiatorRestorer({
      pool,
      access,
      readOperation: readMembershipInitiator,
      readConsent,
    }),
  });
  const prepare = access.prepare!.bind(access);
  access.prepare = async (actor, action, resource, context) => {
    const trace = traces.getStore();
    const restored = trace && restoredActors.get(trace)?.get(resourceKey(action, resource));
    let boundActor = restored ?? actor;
    let boundContext = context;
    if (trace && restored && !accessCommandAttempt(context)) {
      boundActor = restored;
      boundContext = commandAccessContext(context, {
        partition: partitionOf(resource.route),
        basis: {
          actorAccountId: restored.accountId,
          clientId: restored.clientId,
          requestedBy: restored.requestedBy,
        },
        time: trace.time as never,
      });
    }
    if (trace && ['board:read', 'thread:read', 'post:read'].includes(action)) {
      const resources = publicResources.get(trace) ?? new Map<string, Resource>();
      resources.set(resourceKey(action, resource), resource);
      publicResources.set(trace, resources);
    }
    const attempt = accessCommandAttempt(boundContext);
    if (trace && attempt) {
      trace.time = attempt.time;
      trace.at = authoritativeTimeValue(attempt.time);
    }
    return prepare(boundActor, action, resource, boundContext);
  };
  const authorize = access.authorize.bind(access);
  access.authorize = async (...args) => {
    const trace = traces.getStore();
    const [client, suppliedActor, action, resource, evidence, suppliedTime] = args;
    const actor = (trace && restoredActors.get(trace)?.get(resourceKey(action, resource))) ?? suppliedActor;
    let time = suppliedTime;
    if (trace) {
      if (!time) {
        try {
          authoritativeTimeValue(trace.time as never);
          time = trace.time as never;
        } catch {
          time = await mintReadTime(client, clock);
        }
      }
      if (!trace.at) {
        trace.time = time;
        trace.at = authoritativeTimeValue(time);
      }
    }
    const allowed = await authorize(client, actor, action, resource, evidence, time);
    if (trace && time)
      trace.checks.push({
        action,
        resource: { route: resource.route, id: resource.id },
        at: authoritativeTimeValue(time),
        time,
        allowed,
      });
    return allowed;
  };
  let lease = 0;
  const connections = new WeakMap<object, { id: string; trace: Attempt }>();
  pool.on('acquire', (client) => {
    const trace = traces.getStore();
    if (trace) {
      const id = String(++lease);
      connections.set(client, { id, trace });
      trace.reads.push({ kind: 'acquire', connection: id });
    }
  });
  pool.on('release', (_error, client) => {
    const entry = connections.get(client);
    if (entry) entry.trace.reads.push({ kind: 'release', connection: entry.id });
    connections.delete(client);
  });
  pool.on('connect', (client) => {
    const query = client.query;
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const entry = connections.get(client);
      const statement = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string }).text ?? '');
      const text = statement.toLowerCase();
      let stage: ReadStage | undefined;
      if (text.includes('from content.operation')) stage = 'operation';
      else if (text.includes('from core.receipt')) {
        const operationOnConnection = entry?.trace.reads.some(
          (read) => read.kind === 'read' && read.stage === 'operation' && read.connection === entry.id,
        );
        stage = operationOnConnection ? 'operation' : 'provenance';
      } else if (text.includes('access.account')) stage = 'account';
      else if (text.includes('access.principal_assignment')) stage = 'delegation';
      else if (text.includes('access.membership')) stage = 'membership';
      else if (text.includes('content.post') || text.includes('access.resource')) stage = 'resource';
      if (entry && stage) {
        const values = typeof args[0] === 'string' ? args[1] : (args[0] as { values?: unknown }).values;
        const routeParameter = /(?:\broute\s*=\s*\$(\d+)|\$(\d+)::integer\s+AS\s+route\b)/i.exec(statement);
        const partitionParameter = /\bpartition_no\s*=\s*\$(\d+)/i.exec(statement);
        const parameter = routeParameter?.[1] ?? routeParameter?.[2] ?? partitionParameter?.[1];
        const value = parameter && Array.isArray(values) ? values[Number(parameter) - 1] : undefined;
        const partition = typeof value === 'number' ? (routeParameter ? partitionOf(value) : value) : undefined;
        entry.trace.reads.push({
          kind: 'read',
          connection: entry.id,
          stage,
          anchor: statement,
          partitions: partition === undefined ? [] : [partition],
        });
      }
      return Reflect.apply(query, this, args);
    } as typeof client.query;
  });
  const originalRegister = DBOS.registerStep.bind(DBOS);
  DBOS.registerStep = ((func: (...args: any[]) => any, configuration?: { name?: string }) => {
    if (configuration?.name !== 'content.authorErase.step') return originalRegister(func, configuration);
    return originalRegister(async (name: string, action: () => Promise<unknown>) => {
      const workflow = DBOS.workflowID;
      if (!workflow || !/^wf:[^:]+:erase:/.test(name)) return func(name, action);
      const prior = (
        await barriers.query(
          `SELECT serial,name FROM ${barrierTable} WHERE workflow_id=$1 ORDER BY serial DESC LIMIT 1`,
          [workflow],
        )
      ).rows[0];
      const serial = prior?.name === name ? prior.serial : (prior?.serial ?? 0) + 1;
      await barriers.query(
        `INSERT INTO ${barrierTable}(workflow_id,serial,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [workflow, serial, name],
      );
      for (;;) {
        const gate = await barriers.query(`SELECT released FROM ${barrierTable} WHERE workflow_id=$1 AND serial=$2`, [
          workflow,
          serial,
        ]);
        if (gate.rows[0]?.released) break;
        await sleep();
      }
      const trace: Attempt = { result: { outcome: 'denied' }, time: {}, at: '', checks: [], reads: [] };
      let failure: string | null = null;
      try {
        // The command attempt can fail while restoring evidence, before Access
        // receives its opaque T. Preserve a server-minted executor observation
        // for that refusal; successful checks replace it with their exact T.
        trace.time = await withConnection(pool, (connection) => mintReadTime(connection, clock));
        trace.at = authoritativeTimeValue(trace.time as never);
        const value = await traces.run(trace, () => func(name, action));
        if (value?.committed === true) trace.result = { outcome: 'permitted', value, replayed: false };
        else if (value?.committed !== false) throw new Error('Unexpected native erasure page result');
        return value;
      } catch (error) {
        failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
        throw error;
      } finally {
        await barriers.query(
          `UPDATE ${barrierTable} SET attempt=$3::jsonb,error=$4 WHERE workflow_id=$1 AND serial=$2`,
          [workflow, serial, encodeAttempt(trace), failure],
        );
      }
    }, configuration);
  }) as typeof DBOS.registerStep;
  const content = createContentWork({
    storage: new R2Storage({
      endpoint: 'http://127.0.0.1:1',
      bucket: 'unused',
      accessKeyId: 'unused',
      secretAccessKey: 'unused',
      maxObjectBytes: 20 * 1024 * 1024,
      fetch,
    }),
    access,
    readConsent,
    routeKey: Buffer.from(config.routeKey, 'base64url'),
    fetchConfig: { allowedHosts: [] },
  });
  const client = await createWorkClient(config.databaseUrl, pool);
  const contentOperations = createContentOperationClient({ pool, client, clock });
  const work = await composeWork(
    [
      createAccountsWorkModule({ realm: realmMembership, access }),
      communityWorkModule,
      {
        name: 'content',
        async register(context) {
          await content.register(context);
          context.addEffects(contentEffects(context.pool, context.client));
        },
      },
    ],
    {
      databaseUrl: config.databaseUrl,
      executorId: config.executorId,
      pool,
      client,
      clock,
      env: process.env,
    },
  );
  const authorErasureQueue = await client.retrieveQueue(CONTENT_QUEUES.authorErase);
  if (!authorErasureQueue) throw new Error('Native author-erasure queue is missing');
  // Frozen cases park many independent real erasure workflows at native steps.
  // Keep enough worker capacity for those parked runs without changing workflow behavior.
  await authorErasureQueue.setWorkerConcurrency(64);
  await work.launch();
  DBOS.registerStep = originalRegister as typeof DBOS.registerStep;
  const relays = startRelays(pool, [effectsRelay(pool, work.effects), linkProjection(pool)]);
  for (const name of Object.keys(WORK_QUEUES)) await (await DBOS.retrieveQueue(name))!.setMinPollingIntervalMs(1);
  process.stdout.write('ERASURE_WORKER_READY\n');
  const probeAttempt = async (payload: string): Promise<Attempt> => {
    const probe = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      operationId: string;
      point: Point;
      attack: Attack;
      input?: unknown;
    };
    const operationRoute = routeOf(probe.operationId);
    if (operationRoute === null) throw new Error('Native operation route is invalid');
    const time = await withConnection(pool, (connection) => mintReadTime(connection, clock));
    const attempt: Attempt = {
      result: { outcome: 'denied' },
      time,
      at: authoritativeTimeValue(time),
      checks: [],
      reads: [],
    };
    const row = (
      await pool.query<{ actor_account_id: string }>(
        'SELECT actor_account_id FROM content.operation WHERE route=$1 AND operation_id=$2',
        [operationRoute, probe.operationId],
      )
    ).rows[0];
    if (!row) return attempt;

    const operation: Record<string, unknown> = {
      route: operationRoute,
      id: probe.operationId,
      kind: 'content.author-erasure',
      sourceId: probe.operationId,
    };
    let action = probe.point.action;
    const resource = { ...probe.point.resource };
    const injected =
      typeof probe.input === 'object' && probe.input !== null ? (probe.input as Record<string, unknown>) : {};
    const substitutedActor = {
      kind: 'account',
      accountId: row.actor_account_id,
      clientId: 'substituted-client',
      scopes: [],
      requestedBy: null,
      authnEpoch: 1,
    };
    switch (probe.attack) {
      case 'actor':
      case 'serialized-actor':
        operation.actor = injected.actor ?? substitutedActor;
        break;
      case 'client':
        operation.clientId = 'substituted-client';
        break;
      case 'delegator':
        operation.requestedBy = 'urn:rezics:request:invalid:invalid';
        break;
      case 'scopes':
        operation.scopes = injected.actor ?? ['account:read'];
        break;
      case 'epoch':
        operation.authnEpoch = Number.MAX_SAFE_INTEGER + 1;
        break;
      case 'recorded-floor':
        operation.minimumAuthnEpoch = '9999999999999999999';
        break;
      case 'oversized-anchor':
        operation.sourceId = 'x'.repeat(256);
        break;
      case 'oversized-tuple':
        operation.actor = { ...substitutedActor, scopes: Array.from({ length: 101 }, () => 'account:read') };
        break;
      case 'oversized-key':
        operation.idempotencyKey = 'x'.repeat(256);
        break;
      case 'operation-id':
      case 'missing-row':
        operation.id = newId(operationRoute);
        break;
      case 'operation-key':
      case 'other-operation-receipt':
        operation.idempotencyKey = newId(operationRoute);
        break;
      case 'operation-digest':
        operation.requestDigest = '0'.repeat(64);
        break;
      case 'operation-kind':
      case 'domain':
        operation.kind = 'content.other-operation';
        break;
      case 'partition':
        operation.route = (operationRoute + 1) % 65_536;
        break;
      case 'thread':
        operation.threadId = newId(operationRoute);
        break;
      case 'author':
        operation.authorId = newId(operationRoute);
        break;
      case 'purpose':
        operation.purpose = 'content.other-purpose';
        break;
      case 'resource':
        resource.id = newId(resource.route);
        break;
      case 'action':
        action = action.startsWith('post:') ? 'post:revise' : 'account:delete';
        break;
      case 'copied-row':
      case 'missing-source':
        operation.sourceId = newId(operationRoute);
        break;
      case 'uncommitted-receipt':
      case 'rolled-back-create':
        break;
      case 'changed-transaction':
        operation.recordedTransactionId = newId(operationRoute);
        break;
      case 'fixture-callback':
        operation.readOperation = injected;
        break;
      case 'other-access':
        operation.access = { kind: 'untrusted' };
        break;
      case 'originally-stale-tuple':
      case 'refresh-stale-floor':
        break;
      case 'bearer-context':
      case 'resigned-jwt':
        operation.authorization = injected.authorization ?? 'Bearer untrusted';
        break;
      case 'caller-time':
        operation.at = injected.at ?? '2000-01-01T00:00:00.000Z';
        break;
      case 'reuse-step-proof':
        operation.stepProof = injected;
        break;
      case 'missing-receipt':
      case 'changed-source':
        break;
    }
    const kind = action.slice(0, action.indexOf(':'));
    const tableByKind = {
      account: ['access.account', 'account_id'],
      board: ['content.board', 'board_id'],
      thread: ['content.thread', 'thread_id'],
      post: ['content.post', 'post_id'],
    } as const;
    const table = tableByKind[kind as keyof typeof tableByKind];
    if (!table) throw new Error(`Native restore probe has no resource table for ${action}`);
    const accessPool = probe.attack === 'other-pool' ? authPool : pool;
    try {
      const actor = await traces.run(attempt, () =>
        restorer.restoreInitiator(
          {
            operation: operation as never,
            action,
            anchor: {
              resource,
              async validate(connection) {
                const current = await connection.query(`SELECT 1 FROM ${table[0]} WHERE route=$1 AND ${table[1]}=$2`, [
                  resource.route,
                  resource.id,
                ]);
                return current.rowCount === 1;
              },
            },
            context: { pool: accessPool, deadline: Date.now() + 120_000 },
          },
          time,
        ),
      );
      attempt.result = { outcome: 'permitted', value: actor, replayed: false };
    } catch (error) {
      if (!nativeRefusal(error)) throw error;
    }
    return attempt;
  };
  for await (const command of input) {
    if (command === 'stop') {
      await relays.stop();
      await DBOS.shutdown();
      await client.close();
      await Promise.all([pool.end(), barriers.end(), authPool.end()]);
      input.close();
      return;
    }
    const clockCommand = /^clock ([0-9a-f-]{36}) (.+)$/.exec(command);
    if (clockCommand) {
      const timestamp = Date.parse(clockCommand[2]!);
      if (!Number.isFinite(timestamp)) throw new TypeError('Invalid worker clock command');
      workerInstant = timestamp;
      process.stdout.write(`ERASURE_WORKER_CLOCK ${clockCommand[1]}\n`);
      continue;
    }
    const replayCommand = /^replay ([0-9a-f-]{36}) ([0-9a-f-]{36}) (result|cached-result)$/.exec(command);
    const publicCommand = /^public ([0-9a-f-]{36}) ([0-9a-f-]{36})$/.exec(command);
    const probeCommand = /^probe ([0-9a-f-]{36}) ([A-Za-z0-9_-]+)$/.exec(command);
    const encodeResult = (id: string, value: unknown) =>
      process.stdout.write(`ERASURE_WORKER_RESULT ${id} ${Buffer.from(JSON.stringify(value)).toString('base64url')}\n`);
    const encodeError = (id: string, error: unknown) =>
      process.stdout.write(
        `ERASURE_WORKER_ERROR ${id} ${Buffer.from(
          JSON.stringify({
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          }),
        ).toString('base64url')}\n`,
      );
    if (probeCommand) {
      const [, id, payload] = probeCommand;
      try {
        encodeResult(id!, encodeAttempt(await probeAttempt(payload!)));
      } catch (error) {
        encodeError(id!, error);
      }
      continue;
    }
    if (replayCommand) {
      const [, id, operationId, pointId] = replayCommand;
      const attempt: Attempt = { result: { outcome: 'denied' }, time: {}, at: '', checks: [], reads: [] };
      try {
        const operationRoute = routeOf(operationId!);
        if (operationRoute === null) throw new Error('Native operation route is invalid');
        const time = await withConnection(pool, (connection) => mintReadTime(connection, clock));
        attempt.time = time;
        attempt.at = authoritativeTimeValue(time);
        const row = (
          await pool.query<{ actor_account_id: string; anchor_post_id: string; native_workflow_id: string | null }>(
            'SELECT actor_account_id,anchor_post_id,native_workflow_id FROM content.operation WHERE route=$1 AND operation_id=$2',
            [operationRoute, operationId],
          )
        ).rows[0];
        if (!row) {
          encodeResult(id!, encodeAttempt(attempt));
          continue;
        }
        const operation = {
          route: operationRoute,
          id: operationId!,
          kind: 'content.author-erasure',
          sourceId: operationId!,
        };
        const value = await traces.run(attempt, async () => {
          const actorResource = { route: routeOf(row.actor_account_id)!, id: row.actor_account_id };
          const actor = await restorer.restoreInitiator(
            {
              operation,
              action: 'account:read',
              anchor: {
                resource: actorResource,
                async validate(connection) {
                  const current = await connection.query(
                    'SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2',
                    [actorResource.route, actorResource.id],
                  );
                  return current.rowCount === 1;
                },
              },
              context: { pool, deadline: Date.now() + 120_000 },
            },
            time,
          );
          const postResource = { route: operationRoute, id: row.anchor_post_id };
          const postActor = await restorer.restoreInitiator(
            {
              operation,
              action: 'post:erase',
              anchor: {
                resource: postResource,
                async validate(connection) {
                  const current = await connection.query('SELECT 1 FROM content.post WHERE route=$1 AND post_id=$2', [
                    postResource.route,
                    postResource.id,
                  ]);
                  return current.rowCount === 1;
                },
              },
              context: { pool, deadline: Date.now() + 120_000 },
            },
            time,
          );
          const actors = new Map([
            [resourceKey('account:read', actorResource), actor],
            [resourceKey('post:erase', postResource), postActor],
          ]);
          restoredActors.set(attempt, actors);
          return readOperation({ pool, access, clock, workflows: contentOperations }, actor, operationId!, {
            deadline: Date.now() + 120_000,
          });
        });
        attempt.result =
          value === null
            ? { outcome: 'denied' }
            : { outcome: 'permitted', value, replayed: pointId === 'cached-result' };
        encodeResult(id!, encodeAttempt(attempt));
      } catch (error) {
        if (nativeRefusal(error)) {
          attempt.result = { outcome: 'denied' };
          encodeResult(id!, encodeAttempt(attempt));
        } else encodeError(id!, error);
      }
      continue;
    }
    if (publicCommand) {
      const [, id, operationId] = publicCommand;
      try {
        const operationRoute = routeOf(operationId!);
        if (operationRoute === null) throw new Error('Native operation route is invalid');
        const operation = (
          await pool.query<{ thread_id: string; actor_account_id: string; creation_command_kind: string }>(
            `SELECT thread_id,actor_account_id,creation_command_kind FROM content.operation
             WHERE route=$1 AND operation_id=$2`,
            [operationRoute, operationId],
          )
        ).rows[0];
        if (!operation) throw new Error('Native operation disappeared during public read');
        const thread = (
          await pool.query<{ first_post_id: string }>('SELECT first_post_id FROM content.thread WHERE thread_id=$1', [
            operation.thread_id,
          ])
        ).rows[0];
        if (!thread) throw new Error('Native thread has no public opening post');
        const point: Point = {
          id: thread.first_post_id,
          kind: 'step',
          action: 'post:read',
          resource: { route: routeOf(thread.first_post_id)!, id: thread.first_post_id },
          purpose: operation.creation_command_kind,
        };
        const dependencies = { pool, access, tokens: membershipConfig.referenceKeys, clock };
        const anonymous: Attempt = { result: { outcome: 'denied' }, time: {}, at: '', checks: [], reads: [] };
        const readTime = await withConnection(pool, (connection) => mintReadTime(connection, clock));
        anonymous.time = readTime;
        anonymous.at = authoritativeTimeValue(readTime);
        const anonymousValue = await traces.run(anonymous, () =>
          readPost(dependencies, operation.thread_id, thread.first_post_id, {
            actor: { kind: 'anonymous' },
            deadline: Date.now() + 120_000,
          }),
        );
        anonymous.result =
          anonymousValue.value === null
            ? { outcome: 'denied' }
            : { outcome: 'permitted', value: anonymousValue, replayed: false };

        const restored: Attempt = { result: { outcome: 'denied' }, time: {}, at: '', checks: [], reads: [] };
        restored.time = readTime;
        restored.at = authoritativeTimeValue(readTime);
        let restoredValue;
        try {
          restoredValue = await traces.run(restored, async () => {
            const resources = publicResources.get(anonymous);
            const actors = new Map<string, AccountActor>();
            if (!resources?.size) throw new Error('Native public read registered no Access anchors');
            for (const [key, resource] of resources) {
              const action = JSON.parse(key)[0] as string;
              const kind = action.slice(0, action.indexOf(':'));
              const tableByKind = {
                board: ['content.board', 'board_id'],
                thread: ['content.thread', 'thread_id'],
                post: ['content.post', 'post_id'],
              } as const;
              const table = tableByKind[kind as keyof typeof tableByKind];
              if (!table) throw new Error(`Unexpected native public read action ${action}`);
              const actor = await restorer.restoreInitiator(
                {
                  operation: {
                    route: operationRoute,
                    id: operationId!,
                    kind: 'content.author-erasure',
                    sourceId: operationId!,
                  },
                  action,
                  anchor: {
                    resource,
                    async validate(connection) {
                      const current = await connection.query(
                        `SELECT 1 FROM ${table[0]} WHERE route=$1 AND ${table[1]}=$2`,
                        [resource.route, resource.id],
                      );
                      return current.rowCount === 1;
                    },
                  },
                  context: { pool, deadline: Date.now() + 120_000 },
                },
                readTime,
              );
              actors.set(key, actor);
            }
            restoredActors.set(restored, actors);
            const postActor = actors.get(
              resourceKey('post:read', { route: routeOf(thread.first_post_id)!, id: thread.first_post_id }),
            );
            if (!postActor) throw new Error('Native public read has no restored post identity');
            return readPost(dependencies, operation.thread_id, thread.first_post_id, {
              actor: postActor,
              deadline: Date.now() + 120_000,
            });
          });
        } catch (error) {
          if (!nativeRefusal(error)) throw error;
          encodeResult(id!, {
            point,
            anonymous: encodeAttempt(anonymous),
            restored: encodeAttempt(restored),
          });
          continue;
        }
        restored.result =
          restoredValue.value === null
            ? { outcome: 'denied' }
            : { outcome: 'permitted', value: restoredValue, replayed: false };
        encodeResult(id!, {
          point,
          anonymous: encodeAttempt(anonymous),
          restored: encodeAttempt(restored),
        });
      } catch (error) {
        encodeError(id!, error);
      }
      continue;
    }
  }
}

if (import.meta.main && process.env.DURABLE_INITIATOR_WORKER === '1') await runWorker();
