import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { Pool, type PoolClient } from 'pg';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { createContentWork } from '../../src/content/work.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { contentEffects } from '../../src/content/relays.ts';
import { R2Storage } from '../../src/content/r2-storage.ts';
import { effectsRelay } from '../../src/events/effects.ts';
import { startRelays } from '../../src/events/relays.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { composeWork } from '../../src/work/registry.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { accessCommandAttempt } from '../../src/access/command-admission.ts';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromPlainText } from '@rezics/document';
import { decodeJwt } from 'jose';
import reylo from 'reylo/esbuild';
import type {
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
import {
  buildBoardAndThreads,
  createFixtureResources,
  grant,
  request,
  setupRequest,
  revokeGrant,
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
    if (key !== 'time') return value;
    if (typeof value !== 'object' || value === null) throw new Error('Missing native time object');
    let reference = references.get(value);
    if (reference === undefined) references.set(value, (reference = randomUUID()));
    return { nativeTimeReference: reference };
  });
}

function decodeAttempt(wire: Attempt): Attempt {
  const references = new Map<string, object>();
  const time = (value: object) => {
    const reference = (value as { nativeTimeReference?: unknown }).nativeTimeReference;
    if (typeof reference !== 'string') throw new Error('Missing worker time reference');
    let object = references.get(reference);
    if (object === undefined) references.set(reference, (object = Object.freeze(value)));
    return object;
  };
  return { ...wire, time: time(wire.time), checks: wire.checks.map((check) => ({ ...check, time: time(check.time) })) };
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
async function startWorker(resources: FixtureResources) {
  const entry = await (workerBundle ??= buildWorker());
  await resources.pool.query(`CREATE TABLE IF NOT EXISTS ${barrierTable} (
    workflow_id text NOT NULL, serial integer NOT NULL, name text NOT NULL,
    released boolean NOT NULL DEFAULT false, checks jsonb, error text, attempt jsonb,
    PRIMARY KEY (workflow_id,serial)
  )`);
  const child = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, DURABLE_INITIATOR_WORKER: '1' },
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
      executorId: `durable-initiator-${randomUUID()}`,
    })}\n`,
  );
  const wait = (line: string) =>
    until(async () => {
      if (output.includes(line)) return true;
      if (child.exitCode !== null) throw new Error(`Native worker exited: ${output}\n${errors}`);
      return undefined;
    });
  const stop = async () => {
    if (child.exitCode === null) {
      // Leave parked work untouched. Restart must recover native DBOS state.
      child.kill('SIGKILL');
      await child.exited;
    }
    await Promise.all([stdout, stderr]);
  };
  try {
    await wait('ERASURE_WORKER_READY');
    return { stop };
  } catch (error) {
    child.kill();
    await child.exited;
    await Promise.all([stdout, stderr]);
    throw error;
  }
}

/** Stop at the protected-snapshot conflict: native completion cleans earlier
 * committed pages after a later page is denied. Unbound ports must throw rather
 * than manufacture an observation while that contract remains unresolved.
 */
function unboundAfterCleanupConflict(): never {
  throw new Error('Binding incomplete: denied native erasure finishes earlier committed cleanup');
}

export async function createDurableInitiatorDriver(): Promise<DurableInitiatorDriver> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated kernel database');
  let resources: FixtureResources | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  const close = async () => {
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
  try {
    const native = (resources = await createFixtureResources(databaseUrl));
    await native.bootstrap;
    client = await createWorkClient(native.appUrl);
    worker = await startWorker(native);
    const pool = native.pool;
    const operationRow = async (operation: Anchor) => {
      const result = await pool.query('SELECT * FROM content.operation WHERE route=$1 AND operation_id=$2', [
        operation.route,
        operation.id,
      ]);
      return result.rows[0];
    };
    const driver: DurableInitiatorDriver = {
      close,
      async seed(mode = 'delegated') {
        if (mode !== 'direct' && mode !== 'delegated') unboundAfterCleanupConflict();
        native.updateBearer('author', native.system.actors.author.bearer);
        // The shared builder creates two replies through authenticated HTTP.
        // All remaining replies also use the production publish route.
        const board = await buildBoardAndThreads(native, 2, 1, randomUUID());
        const posts = board.targeted.map((post) => post.id);
        for (let index = posts.length; index < 101; index++) {
          const created = await setupRequest<{ post: { id: string } }>(
            native,
            'author',
            'POST',
            `/v1/threads/${board.thread}/posts`,
            {
              body: fromPlainText(`Native erasure target ${index}`),
              licence: 'CC0-1.0',
              subjectIds: [],
              parentId: board.firstPost,
            },
          );
          posts.push(created.post.id);
        }
        const actorId = native.accountIds.author;
        const principalId = mode === 'delegated' ? native.accountIds.unrelated : null;
        let requestedBy: string | undefined;
        if (principalId) {
          // The assignment command's management action is installed in ordinary
          // Access; its implementation still requires the principal's own actor.
          const transition = (await pool.query('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
          await grant(native, 'governance', {
            resource: PLATFORM_RESOURCE,
            subject: { kind: 'account', id: principalId },
            actions: ['access:grant'],
            valid: `[${transition},)`,
          });
          const principal = await native.system.auth.issue({
            accountId: principalId,
            clientId: native.system.auth.ordinaryClient.id,
            scopes: ['access:grant'],
          });
          requestedBy = (
            await createDelegationCommands({ pool, access: native.system.access, action: 'access:grant' }).create(
              { pool, actor: principal.actor, deadline: Date.now() + 10_000 },
              {
                principalId,
                assignedActorId: actorId,
                requestId: newId(routeOf(principalId)!),
                valid: '(,)',
                key: randomUUID(),
              },
            )
          ).value.requestedBy;
          for (const id of posts)
            await grant(native, 'author', {
              resource: { route: board.route, id },
              subject: { kind: 'account', id: principalId },
              actions: ['post:erase', 'post:revise'],
            });
          await grant(native, 'author', {
            resource: { route: routeOf(actorId)!, id: actorId },
            subject: { kind: 'account', id: principalId },
            actions: ['account:read'],
          });
        }
        const outsideAction = 'post:revise';
        // Native first-party renewal uses the actual signed session cookie.
        // Capture it before handing the response unchanged to the shared issuer.
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
          credential = await native.system.auth.issue({
            accountId: actorId,
            clientId: native.system.auth.ordinaryClient.id,
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
        if (response.status === 403 && JSON.parse(wire).code === 'forbidden') return { outcome: 'denied' };
        if (response.status !== 202) throw new Error(`Native erasure creation: ${response.status} ${wire}`);
        const id = (JSON.parse(wire) as { name: string }).name.slice('operations/'.length);
        const operation = { domain: 'content', route: routeOf(id)!, id };
        await until(async () => {
          const row = await operationRow(operation);
          if (!row?.native_workflow_id) return undefined;
          const gate = await pool.query(`SELECT 1 FROM ${barrierTable} WHERE workflow_id=$1 AND serial=1`, [
            row.native_workflow_id,
          ]);
          return gate.rowCount ? true : undefined;
        });
        return { outcome: 'committed', operation };
      },
      async inspect(operation) {
        const row = await operationRow(operation);
        const read = async (table: string) =>
          (await pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(
            (item) => item.value,
          );
        const receipts = await read('core.receipt');
        const events = await read('core.outbox');
        const receipt = row
          ? (
              await pool.query(
                `SELECT * FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
                 AND command_kind=$3 AND idempotency_key=$4`,
                [
                  partitionOf(operation.route),
                  row.initiator_account_id,
                  row.creation_command_kind,
                  row.creation_idempotency_key,
                ],
              )
            ).rows[0]
          : undefined;
        const durableRecords: Snapshot['durableRecords'] = [];
        if (row) durableRecords.push({ source: 'operation', value: row });
        for (const value of receipts) durableRecords.push({ source: 'receipt', value });
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
          protected: {
            receipts,
            effects: events,
            outbox: events,
            resources: (
              await Promise.all(
                ['content.thread', 'content.post', 'content.revision', 'content.media', 'content.operation'].map(read),
              )
            ).flat(),
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
          if (pending?.name === pointId) return;
          if (!pending) {
            if (points.some((point) => point.id === pointId && point.kind !== 'step')) return;
            throw new Error(`No native pending checkpoint ${pointId}`);
          }
          await this.advance(operation, pending.name);
        }
      },
      async advance(operation, pointId) {
        const row = await operationRow(operation);
        const workflow = row!.native_workflow_id;
        const gate = (
          await pool.query(`SELECT serial,name FROM ${barrierTable} WHERE workflow_id=$1 AND name=$2`, [
            workflow,
            pointId,
          ])
        ).rows[0];
        if (!gate) {
          if (pointId !== 'result' && pointId !== 'cached-result') throw new Error(`Unknown point ${pointId}`);
          unboundAfterCleanupConflict();
        }
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
        await until(async () => {
          const next = await pool.query(`SELECT 1 FROM ${barrierTable} WHERE workflow_id=$1 AND serial=$2`, [
            workflow,
            gate.serial + 1,
          ]);
          const status = await client!.getWorkflow(workflow);
          return next.rowCount || (status && ['SUCCESS', 'ERROR'].includes(status.status)) ? true : undefined;
        });
        return decodeAttempt(completed as Attempt);
      },
      async mutate(fixture, mutation) {
        if (mutation !== 'actor-grant' && mutation !== 'principal-grant') unboundAfterCleanupConflict();
        const subjectId = mutation === 'actor-grant' ? fixture.tuple.actor : fixture.principalId;
        if (subjectId === null) throw new Error('Fixture has no principal');
        native.updateBearer('author', native.system.actors.author.bearer);
        const row = await pool.query(
          `SELECT route,resource_id,valid::text FROM access.resource_grant WHERE subject_kind='identity' AND subject_id=$1 AND action='post:erase' AND upper_inf(valid) AND resource_id=(SELECT post_id FROM content.post WHERE thread_id=$2 AND author_account_id=$3 AND availability='available' ORDER BY created_at,post_id LIMIT 1)`,
          [subjectId, fixture.threadId, fixture.authorId],
        );
        for (const item of row.rows)
          await revokeGrant(native, 'author', {
            resource: { route: item.route, id: item.resource_id },
            subject: { kind: 'account', id: subjectId },
            actions: ['post:erase'],
            valid: item.valid,
          });
        const roles = await pool.query(
          `SELECT route,resource_id,grant_role,valid::text FROM access.resource_role_grant WHERE subject_kind='identity' AND subject_id=$1 AND grant_role='content.post.owner' AND upper_inf(valid) AND resource_id=(SELECT post_id FROM content.post WHERE thread_id=$2 AND author_account_id=$3 AND availability='available' ORDER BY created_at,post_id LIMIT 1)`,
          [subjectId, fixture.threadId, fixture.authorId],
        );
        for (const role of roles.rows) {
          await grant(native, 'author', {
            resource: { route: role.route, id: role.resource_id },
            subject: { kind: 'account', id: subjectId },
            actions: ['post:read', 'post:revise', 'media:create'],
            valid: role.valid,
          });
          await setupRequest(
            native,
            'author',
            'POST',
            '/v1/roleGrants:revoke',
            {
              resource: { route: role.route, id: role.resource_id },
              subject: { kind: 'account', id: subjectId },
              role: role.grant_role,
              valid: role.valid,
            },
            200,
          );
        }
        return (await pool.query('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
      },
      async grant() {
        unboundAfterCleanupConflict();
      },
      async attack() {
        unboundAfterCleanupConflict();
      },
      async restart() {
        unboundAfterCleanupConflict();
      },
      async passOriginalExpiry() {
        unboundAfterCleanupConflict();
      },
      async readPublic() {
        unboundAfterCleanupConflict();
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
              'SELECT to_jsonb(t) AS value FROM access.membership_inverse t WHERE account_id=$1 ORDER BY to_jsonb(t)::text',
              [fixture.tuple.actor],
            )
          ).rows.map((row) => row.value),
          blocks: (
            await pool.query(
              'SELECT to_jsonb(t) AS value FROM access.resource_denial t WHERE subject_id=$1 ORDER BY to_jsonb(t)::text',
              [fixture.tuple.actor],
            )
          ).rows.map((row) => row.value),
        };
      },
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
  };
  const pool = new Pool({ connectionString: config.databaseUrl, max: 12 });
  const barriers = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const authPool = new Pool({ connectionString: config.authDatabaseUrl });
  const consent = createCurrentConsentReader({ database: authPool });
  const traces = new AsyncLocalStorage<Attempt>();
  const clock = () => new Date();
  const access = createContentWorkAccess(clock);
  const prepare = access.prepare!.bind(access);
  access.prepare = async (actor, action, resource, context) => {
    const trace = traces.getStore();
    const attempt = accessCommandAttempt(context);
    if (trace && attempt) {
      trace.time = attempt.time;
      trace.at = authoritativeTimeValue(attempt.time);
    }
    return prepare(actor, action, resource, context);
  };
  const authorize = access.authorize.bind(access);
  access.authorize = async (...args) => {
    const allowed = await authorize(...args);
    const trace = traces.getStore();
    const [, , action, resource, , time] = args;
    if (trace && time) {
      trace.time = time;
      trace.at = authoritativeTimeValue(time);
      trace.checks.push({ action, resource: { route: resource.route, id: resource.id }, at: trace.at, time, allowed });
    }
    return allowed;
  };
  let lease = 0;
  const connections = new WeakMap<object, { id: string; trace: Attempt }>();
  pool.on('acquire', (client) => {
    const trace = traces.getStore();
    if (!trace) return;
    const id = String(++lease);
    connections.set(client, { id, trace });
    trace.reads.push({ kind: 'acquire', connection: id });
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
        const releasedOperation = entry?.trace.reads.some(
          (event) =>
            event.kind === 'release' &&
            entry.trace.reads.some(
              (read) => read.kind === 'read' && read.stage === 'operation' && read.connection === event.connection,
            ),
        );
        stage = releasedOperation ? 'provenance' : 'operation';
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
    readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
    routeKey: Buffer.from(config.routeKey, 'base64url'),
    fetchConfig: { allowedHosts: [] },
  });
  const client = await createWorkClient(config.databaseUrl, pool);
  const work = await composeWork(
    [
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
  await work.launch();
  DBOS.registerStep = originalRegister as typeof DBOS.registerStep;
  const relays = startRelays(pool, [effectsRelay(pool, work.effects), linkProjection(pool)]);
  for (const name of Object.keys(WORK_QUEUES)) await (await DBOS.retrieveQueue(name))!.setMinPollingIntervalMs(1);
  process.stdout.write('ERASURE_WORKER_READY\n');
  for await (const command of input) {
    if (command === 'stop') {
      await relays.stop();
      await work.shutdown();
      await client.close();
      await Promise.all([pool.end(), barriers.end(), authPool.end()]);
      input.close();
      return;
    }
  }
}

if (import.meta.main && process.env.DURABLE_INITIATOR_WORKER === '1') await runWorker();
