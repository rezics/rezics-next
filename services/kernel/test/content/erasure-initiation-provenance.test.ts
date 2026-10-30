import { suspendAccount, reinstateAccount } from '../support/native-suspension-driver.ts';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createAuthService, type AuthService } from '@rezics/auth';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { exportJWK, generateKeyPair } from 'jose';
import { Client, Pool } from 'pg';
import canonicalize from 'canonicalize';
import { createAuthDatabase } from '../support/auth-database.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/index.ts';
import { createDelegationCommands, readAssignment } from '../../src/access/delegation-commands.ts';
import {
  createInitiatorRestorer,
  type DurableInitiatorReader,
  type DurableInitiatorRecord,
} from '../../src/access/durable-initiator.ts';
import { beginAuthorErasure, readOperation } from '../../src/content/operations.ts';
import type { AuthorErasureDependencies } from '../../src/content/operation-contract.ts';
import { runCommand } from '../../src/command/command.ts';
import { derivedId, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `erasure_initiati_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
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

const cookies = new Map<string, string>();
const privateBody = Buffer.from(serializeDocument(fromPlainText('private')));
const fixedBody = Buffer.from(serializeDocument(fromPlainText('fixed')));
const fixedBodySha256 = createHash('sha256').update(fixedBody).digest();
const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const db = await openGrowthDatabase();
let authDatabase: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let auth: AuthService;
let access: ReturnType<typeof createAccess>;
let actor: AccountActor;
const tokens = new Map<string, string>();
const issuer = 'https://operations.auth.test';
const actions = ['post:erase', 'account:read', 'account:delegate'];
afterAll(async () => {
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
const otherId = id('other', 0x8131);
const context = (key = crypto.randomUUID()) => ({
  deadline: Date.now() + 10_000,
  idempotencyKey: key,
  requestId: newId(route),
});
const input = { threadId, authorId };
async function renew(accountId: string) {
  for (const scopes of [actions, ['account:read']]) {
    const response = await auth.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          password: 'correct horse battery staple',
          client_id: 'operations-test',
          scope: scopes,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    if (scopes === actions) cookies.set(accountId, cookie);
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
async function verified(accountId: string, scopes = actions) {
  return access.authenticate(tokens.get(`${accountId}:${scopes.join(' ')}`)!, {
    pool: db.pool,
    deadline: Date.now() + 180_000,
  });
}
async function dependencies(): Promise<AuthorErasureDependencies> {
  actor = await verified(authorId);
  return {
    pool: db.pool,
    access,
    clock: () => new Date(),
    workflows: {
      async enqueue() {
        throw new Error('Initiation must publish through the durable outbox');
      },
      async status() {
        return null;
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
      [route, threadId, post, revision, privateBody, id('board'), id('transaction')],
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
      readAssignment: (reference, actorId) => readAssignment(db.pool, reference, actorId),
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
    await renew(accountId);
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

const kind = 'content.author-erasure';
const anchor = (operationId: string) => ({ route, id: operationId, kind, sourceId: operationId });
const columns = [
  'source_digest',
  'original_minimum_authn_epoch',
  'original_operator_account_id',
  'original_delegation_transaction_id',
  'original_delegation_issued_valid',
  'creation_command_kind',
  'creation_idempotency_key',
  'creation_request_digest',
  'creation_target_route',
  'creation_target_id',
] as const;
async function row(operationId: string) {
  return (
    await db.admin.query(
      'SELECT *, upper_created_at::text AS upper_text FROM content.operation WHERE route=$1 AND operation_id=$2',
      [route, operationId],
    )
  ).rows[0];
}
function record(r: Awaited<ReturnType<typeof row>>): DurableInitiatorRecord | null {
  if (
    [
      'source_digest',
      'original_minimum_authn_epoch',
      'creation_command_kind',
      'creation_idempotency_key',
      'creation_request_digest',
      'creation_target_route',
      'creation_target_id',
    ].some((c) => r[c] == null)
  )
    return null;
  if (
    r.actor_requested_by !== null &&
    (r.original_delegation_transaction_id === null || r.original_delegation_issued_valid === null)
  )
    return null;
  return {
    operation: anchor(r.operation_id),
    initiatorAccountId: r.initiator_account_id,
    actor: {
      kind: r.actor_kind,
      accountId: r.actor_account_id,
      clientId: r.actor_client_id,
      scopes: r.actor_scopes,
      requestedBy: r.actor_requested_by,
      authnEpoch: Number(r.actor_authn_epoch),
    },
    recordedTransactionId: r.recorded_transaction_id,
    sourceDigest: r.source_digest,
    originalAccount: {
      minimumAuthnEpoch: r.original_minimum_authn_epoch,
      operatorAccountId: r.original_operator_account_id,
    },
    originalDelegation:
      r.actor_requested_by === null
        ? null
        : { transactionId: r.original_delegation_transaction_id, issuedValid: r.original_delegation_issued_valid },
    creation: {
      commandKind: r.creation_command_kind,
      idempotencyKey: r.creation_idempotency_key,
      requestDigest: r.creation_request_digest,
      target: { route: r.creation_target_route, id: r.creation_target_id },
    },
  };
}
const reader: DurableInitiatorReader = async (client, operation) => {
  const r = (
    await client.query(
      'SELECT *, upper_created_at::text AS upper_text FROM content.operation WHERE route=$1 AND operation_id=$2',
      [operation.route, operation.id],
    )
  ).rows[0];
  if (!r) return null;
  const value = record(r);
  if (!value || canonicalize(operation) !== canonicalize(value.operation) || r.empty_scope) return null;
  if (
    value.sourceDigest !==
    hash({
      operation,
      target: value.creation.target,
      selection: {
        threadId: r.thread_id,
        authorId: r.author_account_id,
        upperCreatedAt: r.upper_text,
        upperPostId: r.upper_post_id,
      },
    })
  )
    return null;
  const receipt = (
    await client.query(
      "SELECT * FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind=$3 AND idempotency_key=$4",
      [partitionOf(route), value.initiatorAccountId, value.creation.commandKind, value.creation.idempotencyKey],
    )
  ).rows[0];
  if (
    !receipt ||
    receipt.transaction_id !== value.recordedTransactionId ||
    Buffer.from(receipt.request_digest).toString('hex') !== value.creation.requestDigest ||
    receipt.response.durableInitiator !== hash(value)
  )
    return null;
  return value;
};
async function restore(operationId: string) {
  const restorer = createInitiatorRestorer({
    pool: db.pool,
    access,
    readOperation: reader,
    readConsent: ({ actorAccountId, clientId }) =>
      createCurrentConsentReader({ database: authPool }).readCurrentConsent({ actorAccountId, clientId }),
  });
  let restored: AccountActor | undefined;
  const outcome = await runCommand(
    db.pool,
    {
      partition: partitionOf(route),
      authorization: {
        action: 'post:erase',
        resource: { route, id: postId },
        denied: () => new Error('Denied'),
        async prepare(attempt) {
          restored = await restorer.restoreInitiator(
            {
              operation: anchor(operationId),
              action: 'post:erase',
              anchor: {
                resource: { route, id: postId },
                async validate(client) {
                  return (
                    (await client.query('SELECT 1 FROM content.post WHERE route=$1 AND post_id=$2', [route, postId]))
                      .rowCount === 1
                  );
                },
              },
              context: { pool: db.pool, deadline: Date.now() + 10000 },
            },
            attempt.time,
          );
        },
        async authorize() {
          return 'execute';
        },
      },
    },
    async () => ({
      value: null,
      events: [{ type: 'erasure-provenance-test.restored', data: { operationId } }],
    }),
  );
  expect(
    (
      await db.admin.query('SELECT type, data FROM core.outbox WHERE partition_no=$1 AND position=$2', [
        outcome.partition,
        outcome.position,
      ])
    ).rows,
  ).toEqual([{ type: 'erasure-provenance-test.restored', data: { operationId } }]);
  return restored;
}
async function delegatedActor() {
  const principal = await verified(otherId);
  await grant(otherId, 'account:delegate', otherId);
  await grant(postId, 'post:erase', otherId);
  await grant(authorId, 'account:read', otherId);
  const requestedBy = (
    await createDelegationCommands({ pool: db.pool, access, action: 'account:delegate' }).create(
      { pool: db.pool, deadline: Date.now() + 10000, actor: principal },
      {
        principalId: otherId,
        assignedActorId: authorId,
        requestId: newId(routeOf(otherId)!),
        valid: '(,)',
        key: crypto.randomUUID(),
      },
    )
  ).value.requestedBy;
  const response = await auth.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: cookies.get(authorId)! },
      body: JSON.stringify({ requested_by: requestedBy }),
    }),
  );
  expect(response.status).toBe(200);
  return access.authenticate(((await response.json()) as { access_token: string }).access_token, {
    pool: db.pool,
    deadline: Date.now() + 10000,
  });
}

test('author erasure initiation commits the allowlisted durable initiator record on its operation and the matching durableInitiator commitment in its own receipt', async () => {
  const deps = await dependencies();
  for (const [delegated, operator] of [
    [false, null],
    [true, null],
    [true, otherId],
  ] as const) {
    await db.admin.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
      routeOf(authorId),
      authorId,
      operator,
    ]);
    const creator = delegated ? await delegatedActor() : await verified(authorId);
    const ctx = context();
    const outcome = await beginAuthorErasure(deps, creator, input, ctx);
    expect(outcome.value).toEqual({ operationId: outcome.value.operationId });
    const r = await row(outcome.value.operationId);
    const committed = record(r);
    expect(committed).not.toBeNull();
    expect(committed!.actor).toEqual(creator);
    expect(committed!.operation).toEqual(anchor(outcome.value.operationId));
    expect(committed!.recordedTransactionId).toBe(outcome.transactionId);
    expect(committed!.originalAccount).toEqual({ minimumAuthnEpoch: '1', operatorAccountId: operator });
    if (creator.requestedBy) {
      const assignment = (
        await db.admin.query(
          'SELECT transaction_id, issued_valid::text AS valid FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3',
          [routeOf(otherId), otherId, creator.requestedBy.split(':').at(-1)],
        )
      ).rows[0];
      expect(committed!.originalDelegation).toEqual({
        transactionId: assignment.transaction_id,
        issuedValid: assignment.valid,
      });
    } else expect(committed!.originalDelegation).toBeNull();
    expect(committed!.creation).toEqual({
      commandKind: kind,
      idempotencyKey: ctx.idempotencyKey,
      requestDigest: hash([
        {
          principal: { kind: 'account', id: creator.accountId },
          basis: { clientId: creator.clientId, requestedBy: creator.requestedBy },
        },
        input,
      ]),
      target: { route, id: postId },
    });
    expect(committed!.sourceDigest).toBe(
      hash({
        operation: committed!.operation,
        target: committed!.creation.target,
        selection: { ...input, upperCreatedAt: r.upper_text, upperPostId: upperId },
      }),
    );
    const receipt = (
      await db.admin.query('SELECT response FROM core.receipt WHERE transaction_id=$1', [outcome.transactionId])
    ).rows[0];
    expect(receipt.response).toEqual({ operationId: outcome.value.operationId, durableInitiator: hash(committed) });
    expect(await restore(outcome.value.operationId)).toEqual(creator);
    const replay = await beginAuthorErasure(deps, creator, input, context(ctx.idempotencyKey));
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual(outcome.value);
    expect(replay.transactionId).toBe(outcome.transactionId);
    expect(await row(outcome.value.operationId)).toEqual(r);
    expect((await readOperation(deps, creator, outcome.value.operationId, context()))?.metadata).toEqual({
      type: 'content.author_erasure',
      ...input,
      processedPosts: 0,
      erasedRevisions: 0,
      steps: 0,
    });
    expect(JSON.stringify(await readOperation(deps, creator, outcome.value.operationId, context()))).not.toContain(
      'durableInitiator',
    );
  }
  await db.admin.query('UPDATE access.account SET operator_account_id=NULL WHERE route=$1 AND account_id=$2', [
    routeOf(authorId),
    authorId,
  ]);
});

test('an operation without provenance, a changed provenance column or a receipt digest mismatch is not restorable', async () => {
  const deps = await dependencies();
  await db.admin.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(authorId),
    authorId,
    otherId,
  ]);
  const creator = await delegatedActor();
  const outcome = await beginAuthorErasure(deps, creator, input, context());
  const operationId = outcome.value.operationId;
  expect(await restore(operationId)).toEqual(creator);
  const original = await row(operationId);
  const changed = [
    '0'.repeat(64),
    '2',
    authorId,
    newId(route),
    '[2000-01-01,2100-01-01)',
    'content.other',
    'other-key',
    '1'.repeat(64),
    route + 1,
    upperId,
  ];
  // Simulate corrupted storage below the immutable-row guard, then restore it.
  await db.admin.query('ALTER TABLE content.operation DISABLE TRIGGER operation_identity');
  try {
    for (const [index, column] of columns.entries()) {
      for (const value of [changed[index], null]) {
        let stored = false;
        try {
          await db.admin.query(`UPDATE content.operation SET ${column}=$3 WHERE route=$1 AND operation_id=$2`, [
            route,
            operationId,
            value,
          ]);
          stored = true;
        } catch (error) {
          expect((error as { code: string }).code).toBe('23514');
        }
        if (stored) await expect(restore(operationId)).rejects.toThrow();
        await db.admin.query(`UPDATE content.operation SET ${column}=$3 WHERE route=$1 AND operation_id=$2`, [
          route,
          operationId,
          original[column],
        ]);
      }
    }
    for (const [column, value] of [
      ['source_digest', 'A'.repeat(64)],
      ['source_digest', 'a'.repeat(63)],
      ['creation_request_digest', 'F'.repeat(64)],
      ['original_minimum_authn_epoch', '0'],
      ['original_minimum_authn_epoch', '01'],
      ['original_minimum_authn_epoch', '1'.repeat(20)],
      ['original_delegation_issued_valid', 'a'.repeat(257)],
      ['original_operator_account_id', '00000000-0000-4000-8000-000000000000'],
      ['original_delegation_transaction_id', '00000000-0000-4000-8000-000000000000'],
      ['creation_target_id', '00000000-0000-4000-8000-000000000000'],
      ['creation_target_route', -1],
      ['creation_idempotency_key', 'has space'],
      ['creation_idempotency_key', 'x'.repeat(256)],
    ] as const) {
      await expect(
        db.admin.query(`UPDATE content.operation SET ${column}=$3 WHERE route=$1 AND operation_id=$2`, [
          route,
          operationId,
          value,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await db.admin.query(
      `UPDATE content.operation SET ${columns.map((c) => `${c}=NULL`).join(',')} WHERE route=$1 AND operation_id=$2`,
      [route, operationId],
    );
    await expect(restore(operationId)).rejects.toThrow();
    await db.admin.query(
      `UPDATE content.operation SET ${columns.map((c, i) => `${c}=$${i + 3}`).join(',')} WHERE route=$1 AND operation_id=$2`,
      [route, operationId, ...columns.map((c) => original[c])],
    );
  } finally {
    await db.admin.query('ALTER TABLE content.operation ENABLE TRIGGER operation_identity');
  }
  await expect(
    db.admin.query('UPDATE content.operation SET source_digest=$3 WHERE route=$1 AND operation_id=$2', [
      route,
      operationId,
      '0'.repeat(64),
    ]),
  ).rejects.toThrow('immutable');
  const receipt = (
    await db.admin.query('SELECT request_digest FROM core.receipt WHERE transaction_id=$1', [outcome.transactionId])
  ).rows[0];
  await db.admin.query('UPDATE core.receipt SET request_digest=$2 WHERE transaction_id=$1', [
    outcome.transactionId,
    Buffer.alloc(32, 9),
  ]);
  await expect(restore(operationId)).rejects.toThrow();
  await db.admin.query('UPDATE core.receipt SET request_digest=$2 WHERE transaction_id=$1', [
    outcome.transactionId,
    receipt.request_digest,
  ]);
  await db.admin.query(
    "UPDATE core.receipt SET response=jsonb_set(response, '{durableInitiator}', to_jsonb($2::text)) WHERE transaction_id=$1",
    [outcome.transactionId, '0'.repeat(64)],
  );
  await expect(restore(operationId)).rejects.toThrow();
  await db.admin.query('UPDATE access.account SET operator_account_id=NULL WHERE route=$1 AND account_id=$2', [
    routeOf(authorId),
    authorId,
  ]);
});

test('a serialization retry captures the committing attempt observation again at its own T', async () => {
  const deps = await dependencies();
  const creator = await delegatedActor();
  let active = true;
  let failed = false;
  const times: Date[] = [];
  const patched = new WeakSet<object>();
  const hook = (client: import('pg').PoolClient) => {
    if (patched.has(client)) return;
    patched.add(client);
    const query = client.query.bind(client);
    client.query = (async (...args: Parameters<typeof client.query>) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
      if (active && text?.includes('INSERT INTO content.operation') && !failed) {
        failed = true;
        throw Object.assign(new Error('Serialization failure'), { code: '40001' });
      }
      return query(...args);
    }) as typeof client.query;
  };
  db.pool.on('acquire', hook);
  try {
    const observed = await capture(db, () =>
      beginAuthorErasure(
        {
          ...deps,
          clock: () => {
            const time = new Date(Math.max(Date.now(), (times.at(-1)?.getTime() ?? 0) + 1));
            times.push(time);
            return time;
          },
        },
        creator,
        input,
        context(),
      ),
    );
    const outcome = observed.value;
    expect(failed).toBe(true);
    expect(times).toHaveLength(2);
    expect(times[1]!.getTime()).toBeGreaterThan(times[0]!.getTime());
    expect(observed.capture.statements.filter((sql) => sql.includes('issued_valid::text'))).toHaveLength(2);
    const committed = await row(outcome.value.operationId);
    expect(committed.requested_at).toEqual(times[1]);
    expect(committed.original_minimum_authn_epoch).toBe('1');
    expect(committed.original_operator_account_id).toBeNull();
    expect(await restore(outcome.value.operationId)).toEqual(creator);
    expect(
      (
        await db.admin.query('SELECT count(*)::int AS n FROM content.operation WHERE recorded_transaction_id=$1', [
          outcome.transactionId,
        ])
      ).rows[0].n,
    ).toBe(1);
  } finally {
    active = false;
    db.pool.off('acquire', hook);
  }
});

test('initiation keeps its wire, admission and one-attempt cost; the growth check holds at three scales', async () => {
  const deps = await dependencies();
  for (const creator of [actor, await delegatedActor()]) {
    const observed = await capture(db, () => beginAuthorErasure(deps, creator, input, context()));
    expect(Object.keys(observed.value.value)).toEqual(['operationId']);
    const statements = observed.capture.statements;
    expect(
      statements.filter(
        (sql) =>
          sql.includes('minimum_authn_epoch::text AS "minimumAuthnEpoch"') && sql.includes('FROM access.account'),
      ),
    ).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes('issued_valid::text'))).toHaveLength(creator.requestedBy ? 1 : 0);
    expect(statements.filter((sql) => sql.includes('INSERT INTO content.operation'))).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes('FROM content.post'))).toHaveLength(1);
  }
  const restricted = await verified(authorId, ['account:read']);
  await expect(beginAuthorErasure(deps, restricted, input, context())).rejects.toThrow();
  const key = context();
  await beginAuthorErasure(deps, actor, input, key);
  await suspendAccount(db.admin, authorId);
  await expect(beginAuthorErasure(deps, actor, input, key)).rejects.toThrow();
  await reinstateAccount(db.admin, authorId);
  await renew(authorId);
  actor = await verified(authorId);
  const population: Population = {
    name: 'erasure-provenance-history',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const noiseThreadId = id(`noise-thread-${ordinal}`);
      const noiseAnchorPostId = id(`noise-anchor-${ordinal}`);
      return {
        'core.receipt': [
          {
            partition_no: partitionOf(route),
            principal_kind: 'account',
            principal_id: id(`receipt-principal-${ordinal}`),
            command_kind: kind,
            idempotency_key: `history-${ordinal}`,
            request_digest: Buffer.alloc(32, 1),
            epoch: 1,
            position: ordinal + 1,
            transaction_id: id(`receipt-transaction-${ordinal}`),
            response: {},
          },
        ],
        'access.resource_grant': [
          {
            route,
            resource_id: id(`grant-${ordinal}`),
            subject_id: authorId,
            action: 'post:erase',
            valid: '(,)',
            transaction_id: id('transaction'),
          },
        ],
        'access.resource_denial': [
          {
            route,
            resource_id: id(`denial-${ordinal}`),
            subject_id: authorId,
            action: 'post:erase',
            reason: 'resource',
            valid: '(,)',
            transaction_id: id('transaction'),
          },
        ],
        'content.thread': [
          {
            route,
            thread_id: noiseThreadId,
            author_account_id: otherId,
            board_id: id('board'),
            title: 'Fixture',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: id('transaction'),
            created_at: new Date('2010-01-01T00:00:00Z'),
          },
        ],
        'content.post': [
          {
            route,
            thread_id: threadId,
            post_id: id(`history-${ordinal}`),
            author_account_id: authorId,
            head_revision_id: id(`revision-${ordinal}`),
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: id('transaction'),
            created_at: new Date('2020-06-01T00:00:00Z'),
          },
          {
            route,
            thread_id: noiseThreadId,
            post_id: noiseAnchorPostId,
            author_account_id: otherId,
            head_revision_id: id(`noise-revision-${ordinal}`),
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: id('transaction'),
            created_at: new Date('2010-01-01T00:00:00Z'),
          },
        ],
        'content.revision': [
          {
            route,
            thread_id: threadId,
            post_id: id(`history-${ordinal}`),
            revision_id: id(`revision-${ordinal}`),
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
            thread_id: noiseThreadId,
            post_id: noiseAnchorPostId,
            revision_id: id(`noise-revision-${ordinal}`),
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
            author_account_id: otherId,
            thread_id: noiseThreadId,
            anchor_post_id: noiseAnchorPostId,
            actor_kind: 'account',
            actor_account_id: authorId,
            actor_client_id: actor.clientId,
            actor_scopes: actor.scopes,
            actor_requested_by: null,
            actor_authn_epoch: 1,
            empty_scope: true,
            requested_at: new Date(),
            recorded_transaction_id: id('transaction'),
          },
        ],
      };
    },
  };
  const report = await checkGrowth(db, {
    name: 'author erasure initiation provenance',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: async (_, scale, previous) => {
      await seed(db, population, { from: previous, to: scale });
    },
    operation: async () => {
      const outcome = await beginAuthorErasure(deps, actor, input, context());
      expect(Object.keys(outcome.value)).toEqual(['operationId']);
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.relations!['content.post']?.rows).toBe(2);
    expect(cost.relations!['core.receipt']?.rows).toBe(1);
    expect(cost.relations!['core.receipt']?.sequentialScans).toBe(0);
    for (const [name, relation] of Object.entries(cost.relations!))
      if (name.startsWith('content.')) expect(relation.sequentialScans).toBe(0);
  }
}, 90000);
