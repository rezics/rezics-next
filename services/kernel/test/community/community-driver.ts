import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { parseItem } from 'structured-headers';
import type {
  Account,
  Command,
  CommunityDriver,
  CommunityGrowth,
  Fixture,
  Subject,
} from '../../../../specs/community-driver.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import readReceipt from '../../src/command/read-receipt.sql';
import { refreshBoardRankBatch } from '../../src/content/board-rank.ts';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import type { QueryResultRow } from 'pg';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import {
  contentGovernanceCredential,
  createContentSystem,
  type ContentCredential,
  type ContentSystem,
} from '../content/support/system.ts';
import { observeSql, type SqlExecution, type SqlObserver } from '../content/support/sql-observer.ts';
import { assertSetupResponse } from '../content/support/setup-response.ts';
import { openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { productionActions } from '../support/production-actions.ts';
import { startConsentServer } from './membership-fixture.ts';

const AUDIENCE = 'https://content.test';

type JsonObject = Record<string, unknown>;

function accountOf(credential: ContentCredential): Account {
  return { id: credential.actor.accountId, bearer: credential.bearer };
}

function workerStream(stream: ReadableStream<Uint8Array> | number | undefined): ReadableStream<Uint8Array> {
  if (typeof stream === 'number' || stream === undefined) throw new Error('Kernel worker pipes are not readable');
  return stream;
}

async function startWorker(system: ContentSystem): Promise<{
  child: Bun.Subprocess;
  failure(): string | undefined;
  output(): string;
  stop(): Promise<void>;
}> {
  const databaseUrl = system.database.pool.options.connectionString;
  if (!databaseUrl) throw new Error('Content fixture database URL is missing');
  const routeKey = Buffer.from(system.routeKey).toString('base64url');
  const sessionKeys = [...system.tokenKeys.keys]
    .map(([id, value]) => `${id}:${Buffer.from(value).toString('base64url')}`)
    .join(',');
  // Auth's current consent over HTTPS from this process: the worker restores initiators from it.
  const consentReader = createCurrentConsentReader({ database: system.database.authPool });
  const consent = await startConsentServer(
    async (input) => (await consentReader.readCurrentConsent(input))?.scopes ?? null,
  );
  const child = Bun.spawn(['bun', 'src/worker.ts'], {
    cwd: resolve(import.meta.dir, '../..'),
    env: workerTestEnv({
      ...process.env,
      DATABASE_URL: databaseUrl,
      KERNEL_ROUTE_KEY: routeKey,
      KERNEL_SESSION_KEYS: sessionKeys,
      KERNEL_EXECUTOR_ID: `community-${crypto.randomUUID()}`,
      KERNEL_WORKER_POOL_SIZE: '6',
      KERNEL_RATING_COUNTER_SECRET: Buffer.alloc(32, 43).toString('base64url'),
      AUTH_ISSUER: 'https://community-worker.auth.test',
      AUTH_AUDIENCE: AUDIENCE,
      AUTH_JWKS_URL: 'https://community-worker.auth.test/.well-known/jwks.json',
      STRIPE_SECRET_KEY: 'sk_test_community_outcomes',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
      CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
      CONTENT_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
      CONTENT_R2_BUCKET: 'content-media',
      CONTENT_R2_ACCESS_KEY_ID: 'private-access-id',
      CONTENT_R2_SECRET_ACCESS_KEY: 'private-secret',
      CONTENT_SOURCE_HOSTS: 'images.example.org',
      ...consent.env,
      OPENSEARCH_URL: '',
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  let workerFailure: string | undefined;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      workerFailure ??= output.match(/Relay (?:effects|semantic_links) stopped[^\n]*/)?.[0];
    }
    output += decoder.decode();
  };
  const diagnostics = Promise.all([pump(workerStream(child.stdout)), pump(workerStream(child.stderr))]);
  const deadline = Date.now() + 90_000;
  while (!output.includes('Worker ready')) {
    if (child.exitCode !== null) {
      await diagnostics;
      await consent.close();
      throw new Error(`Kernel worker exited ${child.exitCode}: ${output}`);
    }
    if (Date.now() >= deadline) {
      child.kill();
      await child.exited;
      await diagnostics;
      await consent.close();
      throw new Error(`Kernel worker did not become ready: ${output}`);
    }
    await Bun.sleep(20);
  }
  let stopping: Promise<void> | undefined;
  return {
    child,
    failure: () => workerFailure,
    output: () => output,
    stop: () =>
      (stopping ??= (async () => {
        if (child.exitCode === null) child.kill();
        await child.exited;
        await diagnostics;
        await consent.close();
      })()),
  };
}

let driverCount = 0;

function parsedKey(value: string): string {
  const [parsed] = parseItem(value);
  if (typeof parsed !== 'string') throw new TypeError('Community command key must be a structured field string');
  return parsed;
}

function responseDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fixtureError(label: string, response: Response): Promise<never> {
  return response
    .clone()
    .text()
    .then((body) => {
      throw new Error(`${label} failed (${response.status}): ${body}`);
    });
}

/** What every test of one file shares: one system, one worker and one SQL observer. */
type SharedCommunity = {
  system: ContentSystem;
  kernel: Kernel;
  worker: Awaited<ReturnType<typeof startWorker>>;
  work: WorkClient;
  observer: SqlObserver;
  provisioned: { fixture: Fixture; governance: Account } | undefined;
  /** `contextId:accountId` pairs already granted the Context moderator role. */
  contextModerators: Set<string>;
  /** Latest scheduled rank refresh time shared by every driver in this file. */
  previousRankRefreshAt: Date | undefined;
  /** Suspensions end the fixture's accounts for good, so the next test builds a new base. */
  retired: boolean;
  closing: Promise<void> | undefined;
};

let shared: SharedCommunity | undefined;

/** Pause this file's worker without changing its HTTP application or database. */
export const worker = {
  async stop(): Promise<void> {
    if (!shared) throw new Error('Community driver is not open');
    await shared.worker.stop();
  },
};

/** Resume native workflows, preserving the worker handle held by existing drivers. */
export async function restartWorker(): Promise<void> {
  if (!shared) throw new Error('Community driver is not open');
  if (shared.worker.child.exitCode === null) throw new Error('Community worker is still running');
  Object.assign(shared.worker, await startWorker(shared.system));
}

async function buildShared(databaseUrl = process.env.DATABASE_URL): Promise<SharedCommunity> {
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  // Durable operations preserve the exact authenticated scope ceiling, which is
  // bounded at 100 tokens. Request this fixture's product scopes through Auth
  // rather than every unrelated action mounted on Kernel.
  const ordinaryScopes = [...productionActions().keys()].filter((action) =>
    /^(account|access|space|realm|board|thread|post|subject|context|definitions|statement|document|copy|moderation|exposure|report|rating):/.test(
      action,
    ),
  );
  const system = await createContentSystem({ databaseUrl, ordinaryScopes });
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let work: WorkClient | undefined;
  let observer: SqlObserver | undefined;
  try {
    const isolatedUrl = system.database.pool.options.connectionString;
    if (!isolatedUrl) throw new Error('Content fixture database URL is missing');
    work = await createWorkClient(isolatedUrl);
    const kernel = createKernel({
      pool: system.database.pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      content: { cursorNow: () => Date.now() },
      access: system.access,
      workClient: work,
      writeRate: createWriteRateLimiter({
        secret: crypto.randomUUID() + crypto.randomUUID(),
        // The tests of a file share one set of accounts, so none of them may spend another's budget.
        overrides: JSON.stringify(
          Object.fromEntries(
            ['anonymous', 'new-account', 'member', 'trusted', 'service'].map((name) => [
              name,
              { write: { maximum: 1_000_000, seconds: 86_400 } },
            ]),
          ),
        ),
      }),
      ratePeer: () => '127.0.0.1',
    });
    worker = await startWorker(system);
    observer = observeSql(system.database.pool);
    return {
      system,
      kernel,
      worker,
      work,
      observer,
      provisioned: undefined,
      contextModerators: new Set(),
      previousRankRefreshAt: undefined,
      retired: false,
      closing: undefined,
    };
  } catch (error) {
    const errors: unknown[] = [error];
    for (const release of [() => observer?.close(), () => work?.close(), () => worker?.stop(), () => system.close()]) {
      try {
        await release();
      } catch (cleanup) {
        errors.push(cleanup);
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Community driver construction failed');
    throw error;
  }
}

/** Ends each part of the base exactly once, in the order the parts depend on one another. */
function closeShared(base: SharedCommunity): Promise<void> {
  return (base.closing ??= (async () => {
    if (shared === base) shared = undefined;
    const errors: unknown[] = [];
    for (const release of [
      () => base.observer.close(),
      () => base.worker.stop(),
      () => base.work.close(),
      () => base.system.close(),
    ]) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Community driver cleanup failed');
  })());
}

/** A test file builds its system and worker once; each test gets its own driver state over them. */
export async function createCommunityDriver(
  options: { databaseUrl?: string; settleTimeoutMs?: number } = {},
): Promise<CommunityDriver> {
  if (shared?.retired) await closeShared(shared);
  const base = (shared ??= await buildShared(options.databaseUrl));
  return bindDriver(base, options.settleTimeoutMs ?? 30_000);
}

/** Ends the system and worker the file's drivers share. Call it once when the file is done. */
export async function closeCommunityDrivers(): Promise<void> {
  if (shared) await closeShared(shared);
}

/** Shared native composition for companion fixtures that need Auth-issued accounts and instrumented reads. */
export function communityFixtureRuntime(): Pick<SharedCommunity, 'system' | 'kernel'> {
  if (!shared) throw new Error('Community driver is not open');
  return { system: shared.system, kernel: shared.kernel };
}

/** Native worker diagnostics for a companion fixture's failed durable operation. */
export function communityWorkerOutput(): string {
  return shared?.worker.output() ?? '';
}

/** Read the isolated fixture database from a companion integration test. */
export async function queryCommunityDatabase<T extends QueryResultRow>(
  statement: string,
  values?: unknown[],
): Promise<T[]> {
  if (!shared) throw new Error('Community driver is not open');
  return (await shared.system.database.pool.query<T>(statement, values)).rows;
}

function bindDriver(base: SharedCommunity, settleTimeoutMs: number): CommunityDriver {
  const { system, kernel, worker, work, observer } = base;
  const pending = new Set<string>();
  let fixture: Fixture | undefined;
  let governanceAccount: Account | undefined;
  let trace: readonly SqlExecution[] = [];
  let serial = 0;
  let growthKernel: Kernel | undefined;
  let growthDatabase: GrowthDatabase | undefined;
  const nextKey = () => JSON.stringify(`driver-${++serial}-${crypto.randomUUID()}`);
  // The spec numbers its keys from one in every test, but the tests share one database: a key
  // is scoped to its driver so one test never replays another's receipt.
  const scope = `t${++driverCount}`;
  const scopedKey = (key: string) => JSON.stringify(`${scope}-${parsedKey(key)}`);

  async function request(command: Command, setup = false): Promise<Response> {
    const mark = observer.records.length;
    const headers = new Headers();
    if (command.actor) headers.set('authorization', `Bearer ${command.actor.bearer}`);
    if (command.key !== undefined) headers.set(IDEMPOTENCY_HEADER, scopedKey(command.key));
    else if (setup && !['GET', 'HEAD'].includes(command.method)) {
      headers.set(IDEMPOTENCY_HEADER, JSON.stringify(crypto.randomUUID()));
    }
    if (command.ifMatch !== undefined) headers.set('if-match', command.ifMatch);
    const init: RequestInit = { method: command.method, headers };
    if (command.body !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(command.body);
    }
    const input = new Request(`${AUDIENCE}${command.path}`, init);
    const response = await (growthKernel ?? kernel).handle(input);
    if (setup) await assertSetupResponse(response, input);
    trace = observer.records.slice(mark);
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as JsonObject | null;
    const direct = body?.workflowId;
    const nested =
      body?.ban && typeof body.ban === 'object' ? (body.ban as Record<string, unknown>).workflowId : undefined;
    if (typeof direct === 'string') pending.add(direct);
    if (typeof nested === 'string') pending.add(nested);
    return response;
  }

  async function checked(
    label: string,
    command: Command,
    statuses: readonly number[] = [200, 201, 202, 204],
  ): Promise<Response> {
    const response = await request(command, true);
    if (!statuses.includes(response.status)) return fixtureError(label, response);
    return response;
  }

  async function settle(): Promise<void> {
    if (worker.failure()) throw new Error(`Production community worker failed: ${worker.failure()}`);
    for (const id of pending) await work.retrieveWorkflow(id).getResult({ pollingIntervalMs: 10 });
    pending.clear();
    const deadline = Date.now() + settleTimeoutMs;
    for (;;) {
      if (worker.failure()) throw new Error(`Production community worker failed: ${worker.failure()}`);
      const workflows = (await work.listWorkflows({ limit: 10_000 })).filter(
        (row) => row.status !== 'SUCCESS' && row.status !== 'DELAYED',
      );
      for (const workflow of workflows)
        await work.retrieveWorkflow(workflow.workflowID).getResult({ pollingIntervalMs: 10 });
      const behind = await system.database.pool.query(`
        SELECT partition.partition_no, partition.position, consumers.name, checkpoint.position AS checkpoint
          FROM core.partition AS partition
          CROSS JOIN (VALUES ('effects'::text), ('semantic_links'::text)) AS consumers(name)
          LEFT JOIN core.consumer_checkpoint AS checkpoint
            ON checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = consumers.name
         WHERE partition.position > COALESCE(checkpoint.position, 0)
         LIMIT 1`);
      if (!behind.rowCount && workflows.length === 0) return;
      if (Date.now() >= deadline)
        throw new Error(
          `Production community worker did not settle: ${JSON.stringify({ behind: behind.rows, workflows, exitCode: worker.child.exitCode })}`,
        );
      await Bun.sleep(10);
    }
  }

  async function createSubject(actor: Account, body: unknown): Promise<Subject> {
    const response = await checked('Fixture subject creation', {
      actor,
      method: 'POST',
      path: '/v1/subjects',
      key: nextKey(),
      body,
    });
    return ((await response.clone().json()) as { subject: Subject }).subject;
  }

  /** Removes every Space, Realm, board and thread, and the grants on them. The Context and the platform stay. */
  async function wipeCommunity(pool: { query: (text: string, values?: unknown[]) => Promise<unknown> }) {
    await pool.query(`
          TRUNCATE
            community.realm_ban,
            community.realm_member_terminal,
            community.realm_member,
            community.realm_revision,
            community.realm,
            community.space_revision,
            community.space,
            content.reaction_total,
            content.board_thread,
            content.revision,
            content.post,
            content.thread,
            content.board
          CASCADE`);
    await pool.query('TRUNCATE access.membership_inverse, access.resource_denial');
    await pool.query(
      `DELETE FROM access.resource_role_grant
            WHERE resource_id <> ALL($1::uuid[])`,
      [[PLATFORM_RESOURCE.id, fixture!.contextId]],
    );
    await pool.query(
      `DELETE FROM access.resource_grant
            WHERE resource_id <> ALL($1::uuid[])`,
      [[PLATFORM_RESOURCE.id, fixture!.contextId]],
    );
    await pool.query(
      `DELETE FROM access.resource_initialization
            WHERE resource_id <> ALL($1::uuid[])`,
      [[PLATFORM_RESOURCE.id, fixture!.contextId]],
    );
  }

  const driver: CommunityDriver = {
    async close() {
      // The growth fixture owns its own pool; the shared base outlives the test unless a suspension retired it.
      try {
        if (growthDatabase) await growthDatabase.close();
      } finally {
        growthDatabase = undefined;
        growthKernel = undefined;
        if (base.retired) await closeShared(base);
      }
    },
    async provision() {
      if (base.provisioned) {
        governanceAccount = base.provisioned.governance;
        const previous = base.provisioned.fixture;
        const response = await checked('Fixture Context creation', {
          actor: previous.owner,
          method: 'POST',
          path: '/v1/contexts',
          key: nextKey(),
          body: { labels: { en: 'Community outcome Context' } },
        });
        const contextId = ((await response.clone().json()) as { context: { id: string } }).context.id;
        const author = await createSubject(previous.subjectOwner, {
          type: 'schema:Person',
          labels: { en: 'Fixture subject author' },
        });
        const subject = await createSubject(previous.subjectOwner, {
          type: 'schema:Book',
          labels: { en: 'Fixture subject' },
          descriptions: { en: 'A globally owned fixture subject' },
          aliases: { en: ['Fixture book'] },
          statements: {
            'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'value', content: author.id } }],
            'schema:inLanguage': [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } }],
          },
        });
        const candidateId = subject.statements['schema:author']?.[0]?.id;
        if (!candidateId) throw new Error('Fixture subject author candidate is missing');
        fixture = {
          ...previous,
          contextId,
          subject: {
            ...previous.subject,
            id: subject.id,
            candidateId,
          },
        };
        return fixture;
      }
      const owner = accountOf(system.actors.author);
      const member = accountOf(system.actors.other);
      const moderator = accountOf(system.actors.moderator);
      governanceAccount = accountOf(await contentGovernanceCredential(system));
      await checked('Fixture outsider reinstatement', {
        actor: governanceAccount,
        method: 'POST',
        path: `/v1/accounts/${system.actors.suspended.actor.accountId}:reinstate`,
        key: nextKey(),
        body: { reason: 'Active independent community outsider' },
      });
      const outsider = accountOf(
        await system.auth.issue({
          accountId: system.actors.suspended.actor.accountId,
          clientId: system.auth.ordinaryClient.id,
          scopes: system.actors.author.actor.scopes,
        }),
      );
      const subjectOwner = governanceAccount;
      const published = await checked('Fixture definitions publication', {
        actor: governanceAccount,
        method: 'POST',
        path: '/v1/definitions/releases',
        key: nextKey(),
        body: { release: bundledRelease },
      });
      const { digest } = (await published.clone().json()) as { digest: string };
      await checked('Fixture definitions activation', {
        actor: governanceAccount,
        method: 'POST',
        path: `/v1/definitions/releases/${digest}:activate`,
        key: nextKey(),
        body: { expected_head: null },
      });
      await checked('Fixture personal library exposure', {
        actor: governanceAccount,
        method: 'POST',
        path: '/v1/platform/exposure/personal_library:open',
        key: nextKey(),
      });
      await checked('Fixture Context creation grant', {
        actor: governanceAccount,
        method: 'POST',
        path: '/v1/grants',
        key: nextKey(),
        body: {
          resource: PLATFORM_RESOURCE,
          subject: { kind: 'account', id: owner.id },
          actions: ['context:create'],
          valid: '(,)',
        },
      });
      const contextResponse = await checked('Fixture Context creation', {
        actor: owner,
        method: 'POST',
        path: '/v1/contexts',
        key: nextKey(),
        body: { labels: { en: 'Community outcome Context' } },
      });
      const contextId = ((await contextResponse.clone().json()) as { context: { id: string } }).context.id;
      const author = await createSubject(subjectOwner, {
        type: 'schema:Person',
        labels: { en: 'Fixture subject author' },
      });
      const subject = await createSubject(subjectOwner, {
        type: 'schema:Book',
        labels: { en: 'Fixture subject' },
        descriptions: { en: 'A globally owned fixture subject' },
        aliases: { en: ['Fixture book'] },
        statements: {
          'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'value', content: author.id } }],
          'schema:inLanguage': [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } }],
        },
      });
      const candidateId = subject.statements['schema:author']?.[0]?.id;
      if (!candidateId) throw new Error('Fixture subject author candidate is missing');
      fixture = {
        owner,
        member,
        moderator,
        outsider,
        subjectOwner,
        contextId,
        subject: { id: subject.id, candidateId, property: 'schema:author', fallback: 'schema:inLanguage' },
        unknown: { realm: newId(0x7101), board: newId(0x7102), thread: newId(0x7103) },
      };
      base.provisioned = { fixture, governance: governanceAccount };
      return fixture;
    },
    request,
    settle,
    async grantModerator(realmId, account) {
      if (!fixture) throw new Error('Community fixture is not provisioned');
      const route = routeOf(realmId);
      if (route === null) throw new TypeError('Realm id is not routed');
      const grant = (resource: { route: number; id: string }, role: string) =>
        request({
          actor: fixture!.owner,
          method: 'POST',
          path: '/v1/roleGrants',
          key: nextKey(),
          body: { resource, subject: { kind: 'account', id: account.id }, role, valid: '(,)' },
        });
      const realmGrant = await grant({ route, id: realmId }, 'community.realm.moderator');
      if (realmGrant.status >= 300) return realmGrant;
      // A Context can serve several Realms, so moderating a Realm never implies authority over its Context.
      const realmRead = await request({
        actor: fixture.owner,
        method: 'GET',
        path: `/v1/realms/${realmId}`,
      });
      if (realmRead.status !== 200) return realmRead;
      const contextId = ((await realmRead.json()) as { realm: { contextId: string } }).realm.contextId;
      const contextRoute = routeOf(contextId);
      if (contextRoute === null) throw new TypeError('Realm Context id is not routed');
      // The Context is shared by every Realm of the fixture; an identical active role grant is refused as a duplicate.
      const key = `${contextId}:${account.id}`;
      if (base.contextModerators.has(key)) return realmGrant;
      const contextGrant = await grant({ route: contextRoute, id: contextId }, 'semantic.context.moderator');
      if (contextGrant.status < 300) base.contextModerators.add(key);
      return contextGrant;
    },
    async suspend(account) {
      if (!governanceAccount) throw new Error('Community governance credential is missing');
      base.retired = true;
      return request({
        actor: governanceAccount,
        method: 'POST',
        path: `/v1/accounts/${account.id}:suspend`,
        key: nextKey(),
        body: { reason: 'Community outcome suspension' },
      });
    },
    async refreshRanks() {
      await settle();
      const now = await system.database.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const at = new Date(
        Math.max(now.rows[0]!.now.getTime(), base.previousRankRefreshAt?.getTime() ?? Number.NEGATIVE_INFINITY) +
          10 * 60_000 +
          ++serial,
      );
      base.previousRankRefreshAt = at;
      while ((await refreshBoardRankBatch(system.database.pool, at)) > 0) {}
    },
    async commandEvidence(actor, commandKey) {
      const storedKey = parsedKey(scopedKey(commandKey));
      const receipts = await system.database.pool.query<{
        key: string;
        response: unknown;
        transactionId: string;
      }>(
        `SELECT idempotency_key AS key, response, transaction_id::text AS "transactionId"
           FROM core.receipt
          WHERE principal_kind='account' AND principal_id=$1 AND idempotency_key=$2
          ORDER BY partition_no, command_kind`,
        [actor.id, storedKey],
      );
      const transactions = receipts.rows.map((row) => row.transactionId);
      const posts =
        transactions.length === 0
          ? []
          : (
              await system.database.pool.query<{ id: string }>(
                `SELECT post_id::text AS id FROM content.post
                  WHERE recorded_transaction_id = ANY($1::uuid[])
                  ORDER BY post_id`,
                [transactions],
              )
            ).rows.map((row) => row.id);
      const receiptRead = trace.some((record) => record.statement === readReceipt.sql);
      const committed = trace.some(
        (record) => record.statement.startsWith('WITH input AS') && record.statement.includes('receipt_write'),
      );
      return {
        posts,
        receipts: receipts.rows.map((row) => ({ key: row.key, responseDigest: responseDigest(row.response) })),
        lastAttempt: {
          authorized: receiptRead,
          receiptRead,
          storedResponseReturned: receiptRead && !committed,
        },
      };
    },
    async growthFixture(): Promise<CommunityGrowth> {
      if (!fixture) throw new Error('Community fixture is not provisioned');
      if (growthDatabase) throw new Error('Community growth fixture is already open');
      // Populations are counted over the whole database, so earlier tests' communities must not be in it.
      await settle();
      await wipeCommunity(system.database.pool);
      const owner = fixture.owner;
      const member = fixture.member;
      const spaceResponse = await checked('Growth Space creation', {
        actor: owner,
        method: 'POST',
        path: '/v1/spaces',
        key: nextKey(),
        body: { title: 'Growth probe host' },
      });
      const space = ((await spaceResponse.clone().json()) as { space: { spaceId: string } }).space;
      const realmResponse = await checked('Growth Realm creation', {
        actor: owner,
        method: 'POST',
        path: '/v1/realms',
        key: nextKey(),
        body: {
          spaceId: space.spaceId,
          title: 'Growth probe Realm',
          visibility: 'public',
          contextId: fixture.contextId,
        },
      });
      let realm = (
        (await realmResponse.clone().json()) as {
          realm: { realmId: string; headRevisionId: string };
        }
      ).realm;
      const scheme = await createSubject(owner, { type: 'skos:ConceptScheme', labels: { en: 'Growth board scheme' } });
      const schemeResponse = await checked('Growth board scheme assignment', {
        actor: owner,
        method: 'PUT',
        path: `/v1/realms/${realm.realmId}/boardScheme`,
        key: nextKey(),
        ifMatch: JSON.stringify(realm.headRevisionId),
        body: { schemeId: scheme.id },
      });
      realm = (
        (await schemeResponse.clone().json()) as {
          realm: { realmId: string; headRevisionId: string };
        }
      ).realm;
      const concept = await createSubject(owner, {
        type: 'skos:Concept',
        labels: { en: 'Growth board concept' },
        statements: {
          'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
        },
      });
      const boardResponse = await checked('Growth board creation', {
        actor: owner,
        method: 'POST',
        path: `/v1/realms/${realm.realmId}/boards`,
        key: nextKey(),
        body: { conceptId: concept.id, title: 'Growth probe board', visibility: 'published' },
      });
      const boardId = ((await boardResponse.clone().json()) as { board: { id: string } }).board.id;
      await checked('Growth member join', {
        actor: member,
        method: 'POST',
        path: `/v1/realms/${realm.realmId}/membership`,
        key: nextKey(),
      });
      await settle();
      const createdThreads: string[] = [];
      for (const title of ['Growth probe first', 'Growth probe second']) {
        const response = await checked('Growth thread creation', {
          actor: owner,
          method: 'POST',
          path: '/v1/threads',
          key: nextKey(),
          body: {
            boardId,
            title,
            body: fromPlainText(title),
            licence: 'CC-BY-4.0',
            subjectIds: [],
            visibility: 'published',
          },
        });
        createdThreads.push(((await response.clone().json()) as { thread: { id: string } }).thread.id);
      }
      await settle();
      const firstRefresh = new Date(Date.now() + 11 * 60_000);
      while ((await refreshBoardRankBatch(system.database.pool, firstRefresh)) > 0) {}
      const initialPage = await request({
        actor: member,
        method: 'GET',
        path: `/v1/boards/${boardId}/threads?sort=hot&limit=2`,
      });
      if (initialPage.status !== 200) return fixtureError('Growth hot probe read', initialPage);
      const threadIds = (
        (await initialPage.clone().json()) as {
          threads: { id: string }[];
        }
      ).threads.map((thread) => thread.id);
      if (threadIds.length !== 2 || threadIds.some((id) => !createdThreads.includes(id)))
        throw new Error('Growth hot probe did not expose exactly its two real threads');

      const isolatedUrl = system.database.pool.options.connectionString;
      if (!isolatedUrl) throw new Error('Content fixture database URL is missing');
      const database = await openGrowthDatabase(isolatedUrl);
      growthDatabase = database;
      growthKernel = createKernel({
        pool: database.pool,
        routeKey: system.routeKey,
        tokens: system.tokenKeys,
        content: { cursorNow: () => Date.now() + 60 * 60_000 },
        access: system.access,
        workClient: work,
        writeRate: createWriteRateLimiter({
          secret: crypto.randomUUID() + crypto.randomUUID(),
          overrides: '{}',
        }),
        ratePeer: () => '127.0.0.1',
      });

      const realmRoute = routeOf(realm.realmId);
      const boardRoute = routeOf(boardId);
      if (realmRoute === null || boardRoute === null || realmRoute !== boardRoute)
        throw new Error('Growth Realm and board are not colocated');
      const hotPartition = partitionOf(boardRoute);
      const at = '2020-01-01T00:00:00.000Z';
      const body = Buffer.from(JSON.stringify(fromPlainText('Unrelated growth thread')));
      const bodyDigest = createHash('sha256').update(body).digest();
      const population: Population = {
        name: `community-outcomes-${crypto.randomUUID()}`,
        hotPartition,
        hotShare: 1,
        rows({ route, ordinal }) {
          const accountId = newId(route);
          const terminalAccountId = newId(route);
          const secondTerminalAccountId = newId(route);
          const spaceId = newId(route);
          const spaceRevisionId = newId(route);
          const realmId = newId(route);
          const realmRevisionId = newId(route);
          const boardId = newId(route);
          const threadId = newId(route);
          const postId = newId(route);
          const revisionId = newId(route);
          const reservationId = newId(route);
          const terminalReservationId = newId(route);
          const secondTerminalReservationId = newId(route);
          const transactionId = crypto.randomUUID();
          const realmRows =
            ordinal === 0
              ? {}
              : {
                  'community.space': [
                    {
                      route,
                      space_id: spaceId,
                      state: 'active',
                      head_revision_id: spaceRevisionId,
                      created_at: at,
                      creator: accountId,
                    },
                  ],
                  'community.space_revision': [
                    {
                      route,
                      space_id: spaceId,
                      revision_id: spaceRevisionId,
                      predecessor: null,
                      title: 'Unrelated growth host',
                      summary: '',
                      created_at: at,
                      author: accountId,
                    },
                  ],
                  'community.realm': [
                    {
                      route,
                      realm_id: realmId,
                      space_id: spaceId,
                      state: 'active',
                      visibility: 'public',
                      context_id: fixture!.contextId,
                      head_revision_id: realmRevisionId,
                      created_at: at,
                      creator: accountId,
                    },
                  ],
                  'community.realm_revision': [
                    {
                      route,
                      realm_id: realmId,
                      revision_id: realmRevisionId,
                      predecessor: null,
                      title: 'Unrelated growth Realm',
                      summary: '',
                      visibility: 'public',
                      context_id: fixture!.contextId,
                      created_at: at,
                      author: accountId,
                    },
                  ],
                  'content.board': [
                    {
                      route,
                      board_id: boardId,
                      subject_id: newId(route),
                      title: 'Unrelated growth board',
                      visibility: 'published',
                      security_revision: 1,
                      recorded_transaction_id: transactionId,
                      created_at: at,
                      realm_id: realmId,
                    },
                  ],
                  'community.realm_member': [
                    {
                      route,
                      realm_id: realmId,
                      account_id: accountId,
                      role: 'member',
                      valid: '[2020-01-01 00:00:00+00,)',
                      reservation_id: reservationId,
                      transaction_id: transactionId,
                    },
                  ],
                  'community.realm_member_terminal': [
                    {
                      route,
                      realm_id: realmId,
                      account_id: terminalAccountId,
                      reservation_id: terminalReservationId,
                      transaction_id: transactionId,
                      at,
                    },
                    ...(ordinal === 1
                      ? [
                          {
                            route,
                            realm_id: realmId,
                            account_id: secondTerminalAccountId,
                            reservation_id: secondTerminalReservationId,
                            transaction_id: transactionId,
                            at,
                          },
                        ]
                      : []),
                  ],
                  'community.realm_ban': [
                    {
                      route,
                      realm_id: realmId,
                      account_id: terminalAccountId,
                      valid: '[2020-01-01 00:00:00+00,)',
                      reason: 'Unrelated growth ban',
                      actor: accountId,
                      transaction_id: transactionId,
                    },
                    ...(ordinal === 1
                      ? [
                          {
                            route,
                            realm_id: realmId,
                            account_id: secondTerminalAccountId,
                            valid: '[2020-01-01 00:00:00+00,)',
                            reason: 'Second unrelated growth ban',
                            actor: accountId,
                            transaction_id: transactionId,
                          },
                        ]
                      : []),
                  ],
                  'access.membership_inverse': [
                    {
                      route,
                      account_id: accountId,
                      kind: 'realm',
                      group_id: realmId,
                      reservation_id: reservationId,
                      transaction_id: transactionId,
                      source_transaction_id: transactionId,
                    },
                  ],
                  'access.resource_role_grant': [
                    {
                      route,
                      resource_id: realmId,
                      subject_kind: 'identity',
                      subject_id: accountId,
                      subject_role: '',
                      grant_role: 'community.realm.member',
                      valid: '[2020-01-01 00:00:00+00,)',
                      transaction_id: transactionId,
                    },
                    {
                      route,
                      resource_id: boardId,
                      subject_kind: 'identity',
                      subject_id: accountId,
                      subject_role: '',
                      grant_role: 'content.board.owner',
                      valid: '[2020-01-01 00:00:00+00,)',
                      transaction_id: transactionId,
                    },
                  ],
                  'access.resource_grant': [
                    {
                      route,
                      resource_id: realmId,
                      subject_kind: 'identity',
                      subject_id: accountId,
                      subject_role: '',
                      action: 'realm:read',
                      valid: '[2020-01-01 00:00:00+00,)',
                      transaction_id: transactionId,
                    },
                  ],
                  'access.resource_denial': [
                    {
                      route,
                      resource_id: realmId,
                      subject_id: terminalAccountId,
                      subject_role: '',
                      action: 'realm:join',
                      reason: 'realm_ban',
                      valid: '[2020-01-01 00:00:00+00,)',
                      transaction_id: transactionId,
                    },
                    ...(ordinal === 1
                      ? [
                          {
                            route,
                            resource_id: realmId,
                            subject_id: secondTerminalAccountId,
                            subject_role: '',
                            action: 'realm:join',
                            reason: 'realm_ban',
                            valid: '[2020-01-01 00:00:00+00,)',
                            transaction_id: transactionId,
                          },
                        ]
                      : []),
                  ],
                };
          const threadRows =
            ordinal < 2
              ? {}
              : {
                  'content.thread': [
                    {
                      route,
                      thread_id: threadId,
                      author_account_id: accountId,
                      board_id: boardId,
                      title: 'Unrelated growth thread',
                      visibility: 'published',
                      security_revision: 1,
                      recorded_transaction_id: transactionId,
                      created_at: at,
                      first_post_id: postId,
                      availability: 'available',
                    },
                  ],
                  'content.post': [
                    {
                      route,
                      thread_id: threadId,
                      post_id: postId,
                      reply_to_post_id: null,
                      author_account_id: accountId,
                      head_revision_id: revisionId,
                      visibility: 'published',
                      security_revision: 1,
                      recorded_transaction_id: transactionId,
                      created_at: at,
                      availability: 'available',
                    },
                  ],
                  'content.revision': [
                    {
                      route,
                      thread_id: threadId,
                      post_id: postId,
                      revision_id: revisionId,
                      body,
                      body_sha256: bodyDigest,
                      search_text: 'Unrelated growth thread',
                      licence: 'CC-BY-4.0',
                      subject_ids: [],
                      board_id: boardId,
                      availability: 'available',
                      recorded_transaction_id: transactionId,
                      recorded_at: at,
                      media_ids: [],
                    },
                  ],
                  'content.board_thread': [
                    {
                      route,
                      board_id: boardId,
                      thread_id: threadId,
                      created_at: at,
                      last_activity_at: at,
                      source_epoch: 1,
                      source_position: ordinal + 1,
                      source_revision_id: revisionId,
                    },
                  ],
                  'content.reaction_total': [
                    {
                      route,
                      target_id: threadId,
                      kind: 'upvote',
                      count: 1,
                      source_epoch: 1,
                      source_position: ordinal + 1,
                    },
                  ],
                };
          return {
            'access.account': [
              { route, account_id: accountId, kind: 'actor', state: 'active', transaction_id: transactionId },
              {
                route,
                account_id: terminalAccountId,
                kind: 'actor',
                state: 'active',
                transaction_id: transactionId,
              },
              {
                route,
                account_id: secondTerminalAccountId,
                kind: 'actor',
                state: 'active',
                transaction_id: transactionId,
              },
            ],
            ...realmRows,
            ...threadRows,
          };
        },
      };
      let refreshAt = firstRefresh.getTime();
      let closed = false;
      return {
        database,
        actor: member,
        realmId: realm.realmId,
        boardId,
        threadIds: threadIds as [string, string],
        async grow(scale, previous) {
          await seed(database, population, { from: previous, to: scale });
          refreshAt += 11 * 60_000;
          while ((await refreshBoardRankBatch(system.database.pool, new Date(refreshAt))) > 0) {}
        },
        async populations() {
          const result = await database.admin.query<{
            realms: number;
            members: number;
            threads: number;
          }>(`SELECT
              (SELECT count(*)::integer FROM community.realm) AS realms,
              (SELECT count(*)::integer FROM community.realm_member) AS members,
              (SELECT count(*)::integer FROM content.thread) AS threads`);
          const row = result.rows[0];
          if (!row) throw new Error('Community growth populations are missing');
          return row;
        },
        async close() {
          if (closed) return;
          closed = true;
          growthKernel = undefined;
          growthDatabase = undefined;
          try {
            await wipeCommunity(database.admin);
          } finally {
            await database.close();
          }
        },
      };
    },
    async subjectCommand(kind, actor, subjectId, commandKey) {
      if (kind === 'edit') {
        return request({
          actor,
          method: 'POST',
          path: `/v1/subjects/${subjectId}/candidates`,
          key: commandKey,
          body: {
            statement: {
              property: { id: 'schema:inLanguage' },
              value: { type: 'value', content: 'fr' },
              references: [
                {
                  parts: [
                    { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source' } },
                  ],
                },
              ],
            },
          },
        });
      }
      return request({
        actor,
        method: 'POST',
        path: `/v1/subjects/${subjectId}:takedown`,
        key: commandKey,
        body: {
          notice: {
            complaint: 'Community outcome fixture takedown',
            received_at: new Date().toISOString(),
          },
        },
      });
    },
  };
  return driver;
}
