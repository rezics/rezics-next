import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, type AuthService } from '@rezics/auth';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { exportJWK, generateKeyPair } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { AccessUnavailableError, createAccess } from '../../src/access/index.ts';
import { installCommandAdmission } from '../../src/access/command-admission.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { problemResponse } from '../../src/http/problem.ts';
import { beginAuthorErasure, readOperation } from '../../src/content/operations.ts';
import type {
  AuthorErasureDependencies,
  NativeWorkflowStatus,
  OperationProgress,
} from '../../src/content/operation-contract.ts';
import { bindAuthorErasureWorkflow } from '../../src/content/erasure-workflow-identity.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import { derivedId, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { AuthenticationError, type AccountActor } from '../../src/request/access.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `operations_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

const db = await openGrowthDatabase();
let authDatabase: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let auth: AuthService;
let access: ReturnType<typeof createAccess>;
let actor: AccountActor;
let other: AccountActor;
const tokens = new Map<string, string>();
const issuer = 'https://operations.auth.test';
const actions = ['post:erase', 'account:read'];
const nativeClients: Awaited<ReturnType<typeof createWorkClient>>[] = [];
const fixedBody = Buffer.from(serializeDocument(fromPlainText('fixed')));
const fixedBodySha256 = createHash('sha256').update(fixedBody).digest();
afterAll(async () => {
  for (const client of nativeClients) await client.close();
  await authPool?.end();
  await authDatabase?.close();
  await db.close();
});
const route = 0x6a31;
const id = (name: string, home = route) => derivedId('00000000-0000-8000-8000-000000000043', name, home);
const threadId = id('thread');
const authorId = id('author', 0x7921);
const postId = id('first');
const upperId = id('upper');
const requested = 'com.rezics.content.author-erasure.requested.v1';
const otherId = id('other', 0x8131);
const context = (key = crypto.randomUUID()) => ({
  deadline: Date.now() + 10_000,
  idempotencyKey: key,
  requestId: newId(route),
});
const input = { threadId, authorId };
let native: NativeWorkflowStatus | null = null;
const statusIds: string[] = [];
async function verified(accountId: string, scopes = actions) {
  return access.authenticate(tokens.get(`${accountId}:${scopes.join(' ')}`)!, {
    pool: db.pool,
    deadline: Date.now() + 180_000,
  });
}
async function dependencies(): Promise<AuthorErasureDependencies> {
  actor = await verified(authorId);
  other = await verified(otherId);
  return {
    pool: db.pool,
    access,
    clock: () => new Date(),
    workflows: {
      async enqueue() {
        throw new Error('Initiation must publish through the durable outbox');
      },
      async status(workflowId) {
        statusIds.push(workflowId);
        return native;
      },
    },
  };
}
async function grant(resource: string, action: string, subject = authorId) {
  await db.admin.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$5) ON CONFLICT DO NOTHING`,
    [routeOf(resource), resource, subject, action, id('transaction')],
  );
}
async function post(name: string, author = authorId, at = '2020-01-01T00:00:00Z') {
  const post = id(name);
  const revision = id(`${name}-revision`);
  const body = Buffer.from(serializeDocument(fromPlainText('private')));
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO content.post
      (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
      VALUES ($1,$2,$3,$4,$5,'published',1,$6,$7)`,
      [route, threadId, post, author, revision, id('transaction'), at],
    );
    await client.query(
      `INSERT INTO content.revision
      (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
      VALUES ($1,$2,$3,$4,$5,sha256($5),'private','CC0-1.0','{}',$6,'available',$7)`,
      [route, threadId, post, revision, body, id('board'), id('transaction')],
    );
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  return post;
}
beforeAll(async () => {
  authDatabase = await cloneAuthDatabase();
  authPool = new Pool({ connectionString: authDatabase.url });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(pair.privateKey)), kid: 'operations-fixture' };
  const approvals = new Set([authorId, otherId]);
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://api.example.test',
    secret: 'operations-fixture-secret-with-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readAccount(accountId) {
        const account = await readAccount(db.pool, routeOf(accountId)!, accountId);
        return (
          account && {
            accountId: account.accountId,
            kind: account.kind,
            state: account.state,
            authnEpoch: Number(account.minimumAuthnEpoch),
            automated: account.operatorAccountId !== null,
            fenced: account.fenced,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('No fixture provisioning approval');
        return { accountId: reference };
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'operations-test', firstParty: true, scopes: actions });
  access = createAccess({
    actions: new Map(actions.map((action) => [action, { anonymous: false }])),
    auth: { ...auth.verifier, fetch: async (url, init) => auth.handler(new Request(url, init)) },
  });
  const password = 'correct horse battery staple';
  for (const accountId of [authorId, otherId]) {
    await db.admin.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','pending',$3)`,
      [routeOf(accountId), accountId, id('transaction')],
    );
    await auth.internal.provisionPassword({ authorization: accountId, email: `${accountId}@example.test`, password });
    await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(accountId),
      accountId,
    ]);
    await grant(accountId, 'account:read', accountId);
    for (const scopes of [actions, ['account:read'], ['post:erase']]) {
      const response = await auth.handler(
        new Request(`${issuer}/signin`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json' },
          body: JSON.stringify({ account_id: accountId, password, client_id: 'operations-test', scope: scopes }),
        }),
      );
      expect(response.status).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const issued = await auth.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: '{}',
        }),
      );
      expect(issued.status).toBe(200);
      tokens.set(`${accountId}:${scopes.join(' ')}`, ((await issued.json()) as { access_token: string }).access_token);
    }
  }
  await db.admin.query(
    `INSERT INTO content.thread
    (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'thread','published',1,$5)`,
    [route, threadId, authorId, id('board'), id('transaction')],
  );
  await post('first');
  await post('upper', authorId, '2021-01-01T00:00:00Z');
  await grant(postId, 'post:erase');
});

async function identity(operationId: string) {
  return (
    await db.admin.query('SELECT * FROM content.operation WHERE route=$1 AND operation_id=$2', [
      routeOf(operationId),
      operationId,
    ])
  ).rows[0];
}
async function source(outcome: Awaited<ReturnType<typeof beginAuthorErasure>>) {
  const consumer = `operations_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.admin.query(
    'INSERT INTO core.consumer_checkpoint (partition_no,consumer,epoch,position) VALUES ($1,$2,$3,$4)',
    [outcome.partition, consumer, outcome.position === 1n ? null : outcome.epoch, outcome.position - 1n],
  );
  let result: Envelope | undefined;
  await readBatch(db.pool, {
    partition: outcome.partition,
    consumer,
    apply: async (envelopes) => {
      result = envelopes[0];
    },
  });
  if (!result) throw new Error('Requested event missing from durable log');
  return result;
}

test('Access unavailability during erasure admission reaches the caller unchanged as 503 without writes', async () => {
  const deps = await dependencies();
  const unavailable = new AccessUnavailableError('overloaded');
  const failingAccess = { ...deps.access };
  installCommandAdmission(failingAccess, async () => {
    throw unavailable;
  });
  const ctx = context();
  const before = await db.admin.query('SELECT count(*) FROM content.operation');
  const error = await beginAuthorErasure({ ...deps, access: failingAccess }, actor, input, ctx).catch(
    (error: unknown) => error,
  );
  expect(error).toBe(unavailable);
  expect(problemResponse(error, { method: 'POST', id: ctx.requestId }).status).toBe(503);
  expect((await db.admin.query('SELECT count(*) FROM content.operation')).rows).toEqual(before.rows);
  expect(
    (await db.admin.query('SELECT 1 FROM core.receipt WHERE idempotency_key=$1', [ctx.idempotencyKey])).rows,
  ).toEqual([]);
});

test('erasure admission denials still answer as GrantDeniedError', async () => {
  const deps = await dependencies();
  for (const denial of [null, new GrantDeniedError(), new Error('Admission refused')]) {
    const deniedAccess = { ...deps.access };
    installCommandAdmission(deniedAccess, async () => {
      if (denial) throw denial;
      return null;
    });
    await expect(beginAuthorErasure({ ...deps, access: deniedAccess }, actor, input, context())).rejects.toBeInstanceOf(
      GrantDeniedError,
    );
  }
});

test('initiation commits one identity and ID-only native source before any worker starts; replay is authorized first', async () => {
  const deps = await dependencies();
  const ctx = context();
  const outcome = await beginAuthorErasure(deps, actor, input, ctx);
  expect(outcome.partition).toBe(partitionOf(route));
  expect(outcome.replayed).toBe(false);
  expect(await beginAuthorErasure(deps, actor, input, ctx)).toEqual({ ...outcome, replayed: true });
  const row = await identity(outcome.value.operationId);
  expect(outcome.value).toEqual({ operationId: row.operation_id });
  expect(row).toMatchObject({
    initiator_account_id: authorId,
    actor_account_id: authorId,
    actor_client_id: actor.clientId,
    actor_scopes: [...actor.scopes],
    thread_id: threadId,
    author_account_id: authorId,
    upper_post_id: upperId,
    upper_created_at: new Date('2021-01-01T00:00:00Z'),
    native_workflow_id: null,
  });
  const envelope = await source(outcome);
  expect(envelope.events.map(({ type, data }) => ({ type, data }))).toEqual([
    { type: requested, data: { operationId: outcome.value.operationId, ...input } },
  ]);
  expect(
    (
      await db.admin.query('SELECT response FROM core.receipt WHERE partition_no=$1 AND idempotency_key=$2', [
        outcome.partition,
        ctx.idempotencyKey,
      ])
    ).rows,
  ).toEqual([
    {
      response: {
        operationId: outcome.value.operationId,
        durableInitiator: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    },
  ]);
  expect(await readOperation(deps, actor, outcome.value.operationId, context())).toEqual({
    name: `operations/${outcome.value.operationId}`,
    metadata: { type: 'content.author_erasure', ...input, processedPosts: 0, erasedRevisions: 0, steps: 0 },
    done: false,
  });
  expect(statusIds).toEqual([]);
  await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action=$3', [
    route,
    postId,
    'post:erase',
  ]);
  await expect(beginAuthorErasure(deps, actor, input, ctx)).rejects.toThrow();
  await grant(postId, 'post:erase');
  const future = await post('future', authorId, '2099-01-01T00:00:00Z');
  expect(future).not.toBe(row.upper_post_id);
  expect((await identity(outcome.value.operationId)).upper_post_id).toBe(upperId);
});

test('selection is never authority: anonymous, unrelated, scope loss and named denials cannot initiate', async () => {
  const deps = await dependencies();
  for (const denied of [{ kind: 'anonymous' } as const, other, await verified(authorId, ['account:read'])])
    await expect(beginAuthorErasure(deps, denied, input, context())).rejects.toThrow();
  await db.admin.query(
    `INSERT INTO access.resource_denial (route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,'post:erase','resource','(,)',$4)`,
    [route, postId, authorId, id('transaction')],
  );
  await expect(beginAuthorErasure(deps, actor, input, context())).rejects.toThrow();
  await db.admin.query('DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2', [route, postId]);
});

test('status conceals noninitiators and current account denials before exact native workflow access', async () => {
  const deps = await dependencies();
  const outcome = await beginAuthorErasure(deps, actor, input, context());
  const envelope = await source(outcome);
  const workflowId = await bindAuthorErasureWorkflow(db.pool, outcome.value.operationId, envelope, 0);
  native = null;
  statusIds.length = 0;
  expect((await readOperation(deps, actor, outcome.value.operationId, context()))?.done).toBe(false);
  expect(statusIds).toEqual([workflowId]);
  statusIds.length = 0;
  for (const denied of [{ kind: 'anonymous' } as const, other, await verified(authorId, ['post:erase'])])
    expect(await readOperation(deps, denied, outcome.value.operationId, context())).toBeNull();
  expect(await readOperation(deps, actor, newId(route), context())).toBeNull();
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(authorId),
    authorId,
  ]);
  // A still-live authenticated read retains its approved account snapshot.
  expect((await readOperation(deps, actor, outcome.value.operationId, context()))?.done).toBe(false);
  expect(statusIds).toEqual([workflowId]);
  statusIds.length = 0;
  // A new request verifies the original signed bearer against current account state.
  const newRequest = verified(authorId).then((fresh) =>
    readOperation(deps, fresh, outcome.value.operationId, context()),
  );
  await expect(newRequest).rejects.toBeInstanceOf(AuthenticationError);
  await expect(newRequest).rejects.toMatchObject({ status: 401 });
  expect(statusIds).toEqual([]);
  await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(authorId),
    authorId,
  ]);
  await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action=$3', [
    routeOf(authorId),
    authorId,
    'account:read',
  ]);
  expect(await readOperation(deps, actor, outcome.value.operationId, context())).toBeNull();
  await grant(authorId, 'account:read');
  expect(statusIds).toEqual([]);
  native = {
    done: true,
    progress: { processedPosts: 3, erasedRevisions: 12, steps: 1 },
    response: { processedPosts: 3, erasedRevisions: 12 },
  };
  expect(await readOperation(deps, actor, outcome.value.operationId, context())).toMatchObject({
    done: true,
    response: { ...native.response },
    metadata: { ...native.progress },
  });
  native = {
    done: true,
    progress: { processedPosts: 1, erasedRevisions: 2, steps: 2 },
    error: { code: 7, message: 'SQL secret stack', details: [{ private: 'provider data' }] },
  };
  const failed = await readOperation(deps, actor, outcome.value.operationId, context());
  expect(failed).toEqual({
    name: `operations/${outcome.value.operationId}`,
    metadata: { type: 'content.author_erasure', ...input, ...native.progress },
    done: true,
    error: { code: 7, message: 'Permission denied' },
  });
  expect(JSON.stringify(failed)).not.toContain('SQL secret');
  native = { done: false, progress: { processedPosts: Number.MAX_SAFE_INTEGER + 1, erasedRevisions: 0, steps: 0 } };
  await expect(readOperation(deps, actor, outcome.value.operationId, context())).rejects.toThrow();
  native = null;
});

test('native operation serializer retains steps and only the approved result fields', async () => {
  const deps = await dependencies();
  const outcome = await beginAuthorErasure(deps, actor, input, context());
  await bindAuthorErasureWorkflow(db.pool, outcome.value.operationId, await source(outcome), 0);
  const progress = { processedPosts: 2, erasedRevisions: 9, steps: 1 };
  const base = {
    name: `operations/${outcome.value.operationId}` as const,
    metadata: { type: 'content.author_erasure' as const, ...input, ...progress },
  };
  try {
    native = { done: false, progress };
    expect(await readOperation(deps, actor, outcome.value.operationId, context())).toEqual({ ...base, done: false });
    // Runtime adapters may supply extra fields; serialize only the public counters.
    const response = { processedPosts: 2, erasedRevisions: 9, steps: 1, total: 99, body: 'private author bytes' };
    native = { done: true, progress: { ...progress, ...response }, response };
    expect(await readOperation(deps, actor, outcome.value.operationId, context())).toEqual({
      ...base,
      done: true,
      response: { processedPosts: 2, erasedRevisions: 9 },
    });
    const maximum = {
      processedPosts: Number.MAX_SAFE_INTEGER,
      erasedRevisions: Number.MAX_SAFE_INTEGER,
      steps: Number.MAX_SAFE_INTEGER,
    };
    native = { done: true, progress: maximum, response: maximum };
    expect(await readOperation(deps, actor, outcome.value.operationId, context())).toEqual({
      name: base.name,
      metadata: { type: 'content.author_erasure', ...input, ...maximum },
      done: true,
      response: { processedPosts: maximum.processedPosts, erasedRevisions: maximum.erasedRevisions },
    });
  } finally {
    native = null;
  }
});

test('terminal Status preserves native failure codes and sanitizes messages and details', async () => {
  const deps = await dependencies();
  const outcome = await beginAuthorErasure(deps, actor, input, context());
  await bindAuthorErasureWorkflow(db.pool, outcome.value.operationId, await source(outcome), 0);
  const progress = { processedPosts: 1, erasedRevisions: 2, steps: 1 };
  try {
    const internal = { code: 13, message: 'Internal error' };
    const cases = [
      ...[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 14, 15, 16].map((code) => ({
        code,
        expected: { code, message: 'Author erasure failed' },
      })),
      { code: 7, expected: { code: 7, message: 'Permission denied' } },
      { code: 13, expected: internal },
      ...[0, -1, 17, 403, NaN, Infinity, 7.5].map((code) => ({ code, expected: internal })),
    ];
    for (const { code, expected } of cases) {
      native = {
        done: true,
        progress,
        error: {
          code,
          message: 'SELECT private author bytes; SQL stack',
          details: [{ token: 'private provider data' }],
        },
      };
      expect(await readOperation(deps, actor, outcome.value.operationId, context())).toEqual({
        name: `operations/${outcome.value.operationId}`,
        metadata: { type: 'content.author_erasure', ...input, ...progress },
        done: true,
        error: expected,
      });
    }
  } finally {
    native = null;
  }
});

test('native counters and pending or terminal result arms fail closed when malformed', async () => {
  const deps = await dependencies();
  const outcome = await beginAuthorErasure(deps, actor, input, context());
  await bindAuthorErasureWorkflow(db.pool, outcome.value.operationId, await source(outcome), 0);
  const progress = { processedPosts: 0, erasedRevisions: 0, steps: 0 };
  const response = { processedPosts: 0, erasedRevisions: 0 };
  try {
    for (const key of ['processedPosts', 'erasedRevisions', 'steps'] as const) {
      for (const invalid of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) {
        native = { done: false, progress: { ...progress, [key]: invalid } } as NativeWorkflowStatus;
        await expect(readOperation(deps, actor, outcome.value.operationId, context())).rejects.toThrow(
          'Invalid native operation counters',
        );
        if (key !== 'steps') {
          native = { done: true, progress, response: { ...response, [key]: invalid } } as NativeWorkflowStatus;
          await expect(readOperation(deps, actor, outcome.value.operationId, context())).rejects.toThrow(
            'Invalid native operation counters',
          );
        }
      }
    }
    const error = { code: 7, message: 'Permission denied' };
    for (const malformed of [
      { done: false, progress, response },
      { done: false, progress, error },
      { done: true, progress },
      { done: true, progress, response, error },
      { done: true, progress, response: null },
      { done: true, progress, error: null },
      { done: 'false', progress },
    ]) {
      native = malformed as NativeWorkflowStatus;
      await expect(readOperation(deps, actor, outcome.value.operationId, context())).rejects.toThrow(
        'Invalid native operation status',
      );
    }
  } finally {
    native = null;
  }
});

test('explicit legal grants, concurrent retries and current named status denials use native authority', async () => {
  const deps = await dependencies();
  const legalDeps = deps;
  await grant(postId, 'post:erase', other.accountId);
  const ctx = context();
  const attempts = await Promise.all([
    beginAuthorErasure(legalDeps, other, input, ctx),
    beginAuthorErasure(legalDeps, other, input, ctx),
  ]);
  expect(attempts[0]!.value).toEqual(attempts[1]!.value);
  expect(attempts.filter(({ replayed }) => !replayed)).toHaveLength(1);
  const operationId = attempts[0]!.value.operationId;
  expect((await identity(operationId)).initiator_account_id).toBe(other.accountId);
  expect((await readOperation(legalDeps, other, operationId, context()))?.done).toBe(false);
  expect(await readOperation(deps, actor, operationId, context())).toBeNull();
  const row = (
    await db.admin.query('SELECT partition_no FROM editorial.write_basis WHERE transaction_id=$1', [
      attempts[0]!.transactionId,
    ])
  ).rows;
  expect(row).toEqual([{ partition_no: partitionOf(route) }]);
  await db.admin.query(
    `INSERT INTO access.resource_denial
    (route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$2,'account:read','resource','(,)',$3)`,
    [routeOf(other.accountId), other.accountId, id('transaction')],
  );
  expect(await readOperation(legalDeps, other, operationId, context())).toBeNull();
  await db.admin.query('DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2', [
    routeOf(other.accountId),
    other.accountId,
  ]);
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(other.accountId),
    other.accountId,
  ]);
  await expect(beginAuthorErasure(legalDeps, other, input, ctx)).rejects.toThrow();
  await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(other.accountId),
    other.accountId,
  ]);
  await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    route,
    postId,
    other.accountId,
  ]);
});

test('checkGrowth measures production initiation and status with fixed Access through same-partition history', async () => {
  const otherAnchorPostId = await post('growth-other-anchor', other.accountId, '2010-01-01T00:00:00Z');
  const population: Population = {
    name: 'operation-history',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'access.resource_grant': Array.from({ length: 64 }, (_, index) => ({
        route,
        resource_id: id(`noise-grant-${ordinal}-${index}`),
        subject_id: authorId,
        action: 'post:erase',
        valid: '(,)',
        transaction_id: id('transaction'),
      })),
      'access.resource_denial': Array.from({ length: 64 }, (_, index) => ({
        route,
        resource_id: id(`noise-denial-${ordinal}-${index}`),
        subject_id: authorId,
        action: 'post:erase',
        reason: 'resource',
        valid: '(,)',
        transaction_id: id('transaction'),
      })),
      'content.post': [
        {
          route,
          thread_id: threadId,
          post_id: id(`history-post-${ordinal}`),
          author_account_id: ordinal % 2 ? authorId : other.accountId,
          head_revision_id: id(`history-revision-${ordinal}`),
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: id('transaction'),
          created_at: new Date('2020-06-01T00:00:00Z'),
        },
      ],
      'content.revision': [
        {
          route,
          thread_id: threadId,
          post_id: id(`history-post-${ordinal}`),
          revision_id: id(`history-revision-${ordinal}`),
          body: fixedBody,
          body_sha256: fixedBodySha256,
          search_text: 'fixed',
          licence: 'CC0-1.0',
          subject_ids: [],
          board_id: id('board'),
          availability: 'available',
          recorded_transaction_id: id('transaction'),
        },
        {
          route,
          thread_id: threadId,
          post_id: postId,
          revision_id: id(`old-revision-${ordinal}`),
          body: fixedBody,
          body_sha256: fixedBodySha256,
          search_text: 'fixed',
          licence: 'CC0-1.0',
          subject_ids: [],
          board_id: id('board'),
          availability: 'available',
          recorded_transaction_id: id('transaction'),
        },
      ],
      'content.operation': [
        {
          route,
          operation_id: id(`noise-${ordinal}`),
          initiator_account_id: authorId,
          author_account_id: other.accountId,
          thread_id: threadId,
          anchor_post_id: otherAnchorPostId,
          actor_kind: 'account',
          actor_account_id: authorId,
          actor_client_id: actor.clientId,
          actor_scopes: actor.scopes,
          actor_requested_by: null,
          actor_authn_epoch: 1,
          empty_scope: true,
          upper_created_at: null,
          upper_post_id: null,
          requested_at: new Date(),
          recorded_transaction_id: id('transaction'),
        },
      ],
    }),
  };
  // A fixed cap-sized actor roster exercises the canonical inverse, not a fake Access.
  await db.admin.query(
    `INSERT INTO access.membership_inverse
    (route,account_id,kind,group_id,reservation_id,transaction_id)
    SELECT $1,$2,'organization',g,g,$4 FROM unnest($3::uuid[]) g`,
    [
      routeOf(authorId),
      authorId,
      Array.from({ length: 1000 }, (_, i) => id(`membership-${i}`, 0x9231)),
      id('transaction'),
    ],
  );
  const deps = await dependencies();
  const client = await createWorkClient(db.url, db.openPool());
  nativeClients.push(client);
  await client.registerQueue('governance', { workerConcurrency: 2 });
  const operation = await beginAuthorErasure(deps, actor, input, context());
  const envelope = await source(operation);
  const workflowId = await bindAuthorErasureWorkflow(db.pool, operation.value.operationId, envelope, 0);
  const nativeDeps: AuthorErasureDependencies = {
    ...deps,
    workflows: {
      enqueue: deps.workflows.enqueue,
      async status(exactId) {
        expect(exactId).toBe(workflowId);
        const status = await client.getWorkflow(exactId);
        if (!status) return null;
        // A zero timeout reads again whenever the first read returns within the same millisecond, so the statement count
        // varies from run to run. A deadline already past makes the read exactly once.
        const progress = await client.getEvent<OperationProgress>(exactId, 'progress', -1);
        return { done: false, progress: progress ?? { processedPosts: 0, erasedRevisions: 0, steps: 0 } };
      },
    },
  };
  expect((await readOperation(nativeDeps, actor, operation.value.operationId, context()))?.done).toBe(false);
  // Relay can retry after a crash between binding and enqueue. DBOS owns deduplication.
  for (let attempt = 0; attempt < 2; attempt++)
    await client.enqueue(
      {
        queueName: 'governance',
        workflowName: 'content.authorErase',
        workflowID: workflowId,
        workflowIDReusePolicy: 'return-existing',
      },
      { operationId: operation.value.operationId },
    );
  expect((await client.getWorkflow(workflowId))?.status).toBe('ENQUEUED');
  const baseline = 4096;
  // Pad the small content/native histories, without changing the fixed roster or the already-large ACL axis.
  await seed(
    db,
    {
      ...population,
      rows: (placement) =>
        Object.fromEntries(
          Object.entries(population.rows!(placement)).filter(([table]) => table.startsWith('content.')),
        ),
    },
    { from: 0, to: baseline },
  );
  const growNative = async (from: number, to: number) => {
    for (let ordinal = from; ordinal < to; ordinal++)
      await client.enqueue(
        {
          queueName: 'governance',
          workflowName: 'content.authorErase',
          workflowID: `operations-growth-${ordinal}`,
        },
        { operationId: id(`noise-${ordinal}`) },
      );
  };
  await growNative(0, baseline);
  // Every run initiates a fresh operation; the full native poll keeps the same workflow identity.
  const report = await checkGrowth(db, {
    name: 'author erasure initiation and status',
    rule: 'series',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: async (_db, scale, previous) => {
      await seed(db, population, { from: baseline + previous, to: baseline + scale });
      // Grow native identities too; the observed target and its bounded inputs stay fixed.
      await growNative(baseline + previous, baseline + scale);
      await db.admin.query('ANALYZE dbos.workflow_status');
    },
    operation: async () => {
      const outcome = await beginAuthorErasure(deps, actor, input, context());
      expect((await readOperation(deps, actor, outcome.value.operationId, context()))?.done).toBe(false);
      expect((await readOperation(nativeDeps, actor, operation.value.operationId, context()))?.done).toBe(false);
    },
  });
  expect(report.rule).toBe('series');
  for (const sample of report.samples)
    for (const cost of sample.repetitions) {
      expect(cost.relations['content.post']?.sequentialScans).toBe(0);
      expect(cost.relations['content.post']?.rows).toBe(2);
      expect(cost.relations['content.operation']?.sequentialScans).toBe(0);
      expect(cost.relations['dbos.workflow_status']?.sequentialScans).toBe(0);
    }
  expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
  expect(report.samples.every(({ cost }) => cost.rows > 0 && cost.statements > 0)).toBe(true);
  const largest = report.samples.at(-1)!.cost;
  expect(largest.relations!['content.post']?.sequentialScans).toBe(0);
  expect(largest.relations!['content.post']?.rows).toBe(2);
  expect(largest.relations!['access.membership_inverse']?.rows).toBeGreaterThanOrEqual(1000);
  expect(Object.keys(largest.relations!)).not.toContain('dbos.operation_outputs');
  await client.close();
}, 90_000);
