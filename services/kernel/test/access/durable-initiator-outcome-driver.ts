import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromPlainText } from '@rezics/document';
import { decodeJwt } from 'jose';
import reylo from 'reylo/esbuild';
import type {
  Anchor,
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
  type FixtureResources,
} from '../content/support/erasure-operation-fixtures.ts';

const barrierTable = 'content.erasure_operation_test_barrier';
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 15));
let workerBundle: Promise<string> | undefined;

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
    entrypoints: [fileURLToPath(new URL('../content/erasure-operation-driver.ts', import.meta.url))],
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

/** Transport the existing content worker, including its native step barriers.
 * This process owns only the child and the randomly cloned fixture databases.
 */
async function startWorker(resources: FixtureResources) {
  const entry = await (workerBundle ??= buildWorker());
  await resources.pool.query(`CREATE TABLE ${barrierTable} (
    workflow_id text NOT NULL, serial integer NOT NULL, name text NOT NULL,
    released boolean NOT NULL DEFAULT false, checks jsonb, error text,
    PRIMARY KEY (workflow_id,serial)
  )`);
  const child = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, ERASURE_OPERATION_WORKER: '1' },
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
      initialMode: 'hold',
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
      // Release only this worker's barriers before asking DBOS to drain.
      child.stdin.write('run\nstop\n');
      await child.stdin.flush();
      await child.exited;
    }
    await Promise.all([stdout, stderr]);
    if (child.exitCode !== 0) throw new Error(`Native worker failed: ${output}\n${errors}`);
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

/** The binding stops at the native registry conflict. Unbound ports throw;
 * they must never manufacture a native refusal or successful observation.
 */
function unboundAfterRegistryConflict(): never {
  throw new Error('Binding incomplete: resolve the native durable boundary registry contract first');
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
    return {
      close,
      async seed(mode = 'delegated') {
        if (mode !== 'direct' && mode !== 'delegated') unboundAfterRegistryConflict();
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
        await client!.listWorkflowSteps(row.native_workflow_id);
        const gates = await pool.query(`SELECT name FROM ${barrierTable} WHERE workflow_id=$1 ORDER BY serial`, [
          row.native_workflow_id,
        ]);
        const points: Point[] = gates.rows.map((gate) => ({
          id: gate.name,
          kind: 'step',
          action: 'post:erase',
          resource: { route: operation.route, id: row.anchor_post_id },
          purpose: row.creation_command_kind,
        }));
        return points;
      },
      async park() {
        unboundAfterRegistryConflict();
      },
      async advance() {
        unboundAfterRegistryConflict();
      },
      async mutate() {
        unboundAfterRegistryConflict();
      },
      async grant() {
        unboundAfterRegistryConflict();
      },
      async attack() {
        unboundAfterRegistryConflict();
      },
      async restart() {
        unboundAfterRegistryConflict();
      },
      async passOriginalExpiry() {
        unboundAfterRegistryConflict();
      },
      async readPublic() {
        unboundAfterRegistryConflict();
      },
      async authority() {
        unboundAfterRegistryConflict();
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Durable initiator setup and cleanup failed');
    }
    throw error;
  }
}
