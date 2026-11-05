import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService } from '@rezics/auth';
import { fromPlainText } from '@rezics/document';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

// The focused acceptance command also runs from the repository root.
await import('reylo/register');
const { productionActions } = await import('../support/production-actions.ts');
const { createPool } = await import('../../src/database/pool.ts');
const { readAccount } = await import('../../src/access/account-data.ts');
const { createAccess } = await import('../../src/access/index.ts');
const { setBoardScheme } = await import('../../src/community/board-scheme.ts');
const { createRealmMembership } = await import('../../src/community/membership.ts');
const { publish, reject, withdraw } = await import('../../src/community/publication.ts');
const { createRealm, updateRealm } = await import('../../src/community/realm.ts');
const { claimSpaceAddress } = await import('../../src/community/space-address.ts');
const { createSpace, updateSpace } = await import('../../src/community/space.ts');
const { createBoard } = await import('../../src/content/board-create.ts');
const { createPost, createThread, revisePost } = await import('../../src/content/commands.ts');
const { EVENT_TYPES: EVENT_TYPESGetter, readBatch } = await import('../../src/events/log.ts');
const EVENT_TYPES = EVENT_TYPESGetter();
const { newId, routeOf } = await import('../../src/route/route.ts');
const { bootstrapRelease, GLOBAL_CONTEXT } = await import('../../src/semantic/definitions.ts');
const { createSubject, subjectTarget } = await import('../../src/semantic/subject.ts');

const routeKey = new Uint8Array(32).fill(37);
const root = { route: 0, id: GLOBAL_CONTEXT };
const issuer = 'https://community-events.auth.test';
const audience = 'https://community-events.api.test';
const mounted = [
  'access:grant',
  'board:create',
  'board:read',
  'context:read',
  'media:create',
  'post:create',
  'post:erase',
  'post:read',
  'post:revise',
  'reaction:set',
  'realm:create',
  'realm:join',
  'realm:manage',
  'realm:publish',
  'realm:read',
  'space:create',
  'space:manage',
  'space:read',
  'subject:read',
  'thread:create',
  'thread:read',
];
const seenCommunity = [
  'com.rezics.community.publication.adopted.v1',
  'com.rezics.community.publication.rejected.v1',
  'com.rezics.community.publication.withdrawn.v1',
  'com.rezics.community.realm.board-scheme.v1',
  'com.rezics.community.realm.created.v1',
  'com.rezics.community.realm.membership.terminalized.v1',
  'com.rezics.community.realm.membership.v1',
  'com.rezics.community.realm.updated.v1',
  'com.rezics.community.space.address-activated.v1',
  'com.rezics.community.space.address-changed.v1',
  'com.rezics.community.space.address-claim-accepted.v1',
  'com.rezics.community.space.address-claim-pending.v1',
  'com.rezics.community.space.address-reserved.v1',
  'com.rezics.community.space.created.v1',
  'com.rezics.community.space.updated.v1',
];
const schemaOnly = ['com.rezics.community.space.address-reservation-skipped.v1'];
const contentCreated = [
  'com.rezics.content.board.created.v1',
  'com.rezics.content.post.created.v1',
  'com.rezics.content.revision.created.v1',
  'com.rezics.content.thread.created.v1',
];

const key = () => randomUUID();
const context = () => ({ idempotencyKey: key(), deadline: Date.now() + 90_000 });
const request = () => ({ ...context(), requestId: key() });

type Fixture = {
  access: ReturnType<typeof createAccess>;
  actor: AccountActor;
  grant: (id: string, target: { route: number; id: string }, action: string) => Promise<void>;
  close: () => Promise<void>;
};

async function fixture(kernel: ReturnType<typeof createPool>, admin: Pool): Promise<Fixture> {
  const url = new URL(process.env.DATABASE_URL!);
  const database = `event_schema_auth_${process.pid}`;
  await dropTestDatabase(admin, database);
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`;
  migrateAuth(url.href);
  const authPool = new Pool({ connectionString: url.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'community-events',
  };
  const accountId = newId(0x1234);
  const password = 'community event schema password with enough entropy';
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'community-event-schema-secret-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const row = await readAccount(admin, routeOf(id)!, id);
        return (
          row && {
            accountId: row.accountId,
            kind: row.kind,
            state: row.state,
            authnEpoch: Number(row.minimumAuthnEpoch),
            automated: false,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (reference !== accountId) throw new Error('Unknown fixture provisioning reference');
        return { accountId: reference };
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'community-events', firstParty: true, scopes: mounted });
  const access = createAccess({
    actions: productionActions(),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async (input, init) => auth.handler(new Request(input, init)),
    },
  });
  await admin.query(
    "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','pending',$2)",
    [routeOf(accountId), accountId],
  );
  await auth.internal.provisionPassword({
    authorization: accountId,
    email: `${accountId}@community-events.test`,
    password,
  });
  await admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(accountId),
    accountId,
  ]);
  const signin = await auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${accountId}@community-events.test`,
        password,
        client_id: 'community-events',
        scope: mounted,
      }),
    }),
  );
  expect(signin.status).toBe(200);
  const cookie = signin.headers
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
  const token = ((await issued.json()) as { access_token: string }).access_token;
  const actor = await access.authenticate(token, { pool: kernel, deadline: Date.now() + 600_000 });
  if (actor.kind !== 'account') throw new Error('Auth did not issue an account actor');
  async function grant(id: string, target: { route: number; id: string }, action: string) {
    await admin.query(
      "INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)'::tstzrange,$3) ON CONFLICT DO NOTHING",
      [target.route, target.id, id, action],
    );
  }
  return {
    access,
    actor,
    grant,
    async close() {
      await authPool.end();
      await dropTestDatabase(admin, database);
    },
  };
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & { code?: string; detail?: string };
  return [extra.name, extra.code, extra.message, extra.detail].filter(Boolean).join(': ');
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${name} failed: ${describe(error)}`, { cause: error });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('event data is not an object');
  return value as Record<string, unknown>;
}

function schemaOf(type: string) {
  if (!Object.hasOwn(EVENT_TYPES, type)) return undefined;
  return EVENT_TYPES[type as keyof typeof EVENT_TYPES];
}

function rejectsExtra(type: string, data: Record<string, unknown>) {
  const schema = schemaOf(type);
  if (!schema) throw new Error(`missing schema ${type}`);
  expect(Value.Check(schema, data)).toBe(true);
  expect(Value.Check(schema, { ...data, unexpected: true })).toBe(false);
}

let pool: ReturnType<typeof createPool>;
let admin: Pool;
let f: Fixture;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  pool = createPool(url);
  admin = new Pool({ connectionString: url });
  f = await fixture(pool, admin);
}, 60_000);

afterAll(async () => {
  await f?.close();
  await pool?.end();
  await admin?.end();
});

test('community and content commands leave a log readBatch decodes, each emitted type closed', async () => {
  const actor = f.actor;
  const deps = () => ({ pool, access: f.access, routeKey });
  await step('release', () => bootstrapRelease(pool, bundledRelease));
  await step('grant space', () => f.grant(actor.accountId, root, 'space:create'));
  await step('grant realm', () => f.grant(actor.accountId, root, 'realm:create'));

  const space = await step('create space', () =>
    createSpace(deps(), actor, { title: 'Host Space', summary: 'A catalogue space' }, context()),
  );
  const spaceUpdated = await step('update space', () =>
    updateSpace(
      deps(),
      actor,
      { spaceId: space.value.spaceId, expectedHead: space.value.revisionId, title: 'Host Space revised' },
      context(),
    ),
  );
  const claimed = await step('claim address', () =>
    claimSpaceAddress(
      deps(),
      actor,
      { spaceId: space.value.spaceId, expectedHead: spaceUpdated.value.revisionId, address: 'cataloguealpha' },
      context(),
    ),
  );
  const moved = await step('claim replacement address', () =>
    claimSpaceAddress(
      deps(),
      actor,
      { spaceId: space.value.spaceId, expectedHead: claimed.value.revisionId, address: 'cataloguebeta' },
      context(),
    ),
  );
  await step('accept current address', () =>
    claimSpaceAddress(
      deps(),
      actor,
      { spaceId: space.value.spaceId, expectedHead: moved.value.revisionId, address: 'cataloguebeta' },
      context(),
    ),
  );

  const realm = await step('create realm', () =>
    createRealm(
      deps(),
      actor,
      {
        spaceId: space.value.spaceId,
        title: 'First Realm',
        summary: 'A community',
        visibility: 'public',
        contextId: GLOBAL_CONTEXT,
      },
      context(),
    ),
  );
  const realmUpdated = await step('update realm', () =>
    updateRealm(
      deps(),
      actor,
      { realmId: realm.value.realmId, expectedHead: realm.value.revisionId, title: 'First Realm revised' },
      context(),
    ),
  );
  await step('grant join', () =>
    f.grant(actor.accountId, { route: routeOf(realm.value.realmId)!, id: realm.value.realmId }, 'realm:join'),
  );
  const account = await readAccount(pool, routeOf(actor.accountId)!, actor.accountId);
  if (!account) throw new Error('missing account');
  const membership = createRealmMembership({ pool, access: f.access });
  const reservation = {
    accountId: actor.accountId,
    principal: { kind: 'realm' as const, id: realm.value.realmId },
    reservationId: newId(routeOf(actor.accountId)!),
  };
  await step('publish membership', () =>
    membership.publish(
      { actor, account, deadline: Date.now() + 90_000 },
      {
        kind: 'membership',
        principal: reservation.principal,
        memberAccountId: actor.accountId,
        role: 'member',
        authorization: key(),
      },
      reservation,
      key(),
    ),
  );
  await step('terminalize membership', () =>
    membership.terminalize({ ...reservation, reservationId: newId(routeOf(actor.accountId)!) }, key()),
  );

  async function subject(type: string, inScheme?: string) {
    const idempotencyKey = key();
    const item = {
      type,
      labels: { en: type },
      ...(inScheme === undefined
        ? {}
        : {
            statements: {
              'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: inScheme } }],
            },
          }),
    };
    const created = await createSubject(pool, {
      actor,
      target: subjectTarget(routeKey, actor.accountId, idempotencyKey),
      idempotencyKey,
      digest: createHash('sha256').update(JSON.stringify(item)).digest(),
      item,
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
      deadline: Date.now() + 90_000,
    });
    return created.subject.id;
  }

  const schemeId = await step('scheme', () => subject('skos:ConceptScheme'));
  await step('board scheme', () =>
    setBoardScheme(
      deps(),
      actor,
      { realmId: realm.value.realmId, schemeId, expectedHead: realmUpdated.value.revisionId },
      context(),
    ),
  );
  const conceptId = await step('concept', () => subject('skos:Concept', schemeId));
  const adopted = await step('publish', () =>
    publish(deps(), actor, { realmId: realm.value.realmId, subjectId: conceptId }, context()),
  );
  const withdrawn = await step('withdraw', () =>
    withdraw(
      deps(),
      actor,
      { realmId: realm.value.realmId, subjectId: conceptId, expectedHead: adopted.value.publicationId },
      context(),
    ),
  );
  await step('reject', () =>
    reject(
      deps(),
      actor,
      { realmId: realm.value.realmId, subjectId: conceptId, expectedHead: withdrawn.value.publicationId },
      context(),
    ),
  );
  const board = await step('board', () =>
    createBoard(
      deps(),
      actor,
      { realmId: realm.value.realmId, conceptId, title: 'Fiction board', visibility: 'published' },
      context(),
    ),
  );
  const thread = await step('thread', () =>
    createThread(
      deps(),
      actor,
      {
        title: 'Catalogue thread',
        body: fromPlainText('First exact authored body'),
        licence: 'MIT',
        subjectIds: [],
        boardId: board.value.boardId,
        visibility: 'published',
      },
      request(),
    ),
  );
  const post = await step('post', () =>
    createPost(
      deps(),
      actor,
      {
        threadId: thread.value.threadId,
        body: fromPlainText('A reply'),
        licence: 'MIT',
        subjectIds: [],
      },
      request(),
    ),
  );
  await step('revision', () =>
    revisePost(
      deps(),
      actor,
      {
        threadId: thread.value.threadId,
        itemId: post.value.itemId,
        body: fromPlainText('A revised reply'),
        licence: 'MIT',
        expectedRevisionId: post.value.revisionId,
      },
      request(),
    ),
  );

  const seen = new Set<string>();
  const payloads = new Map<string, Record<string, unknown>[]>();
  const partitions = await pool.query<{ partition_no: number }>(
    'SELECT partition_no FROM core.partition WHERE position > 0 ORDER BY partition_no',
  );
  expect(partitions.rows.length).toBeGreaterThan(0);
  for (const row of partitions.rows) {
    for (;;) {
      const result = await readBatch(pool, {
        consumer: 'community_event_schemas',
        partition: row.partition_no,
        apply: async (envelopes) => {
          for (const envelope of envelopes) {
            for (const event of envelope.events) {
              seen.add(event.type);
              const list = payloads.get(event.type) ?? [];
              list.push(record(event.data));
              payloads.set(event.type, list);
            }
          }
        },
      });
      if (result.status === 'busy') continue;
      if (result.status === 'stopped') {
        const failed = await pool.query(
          `SELECT position::text, event_seq, type, data FROM core.outbox
           WHERE partition_no = $1 AND position > $2 ORDER BY position, event_seq LIMIT 3`,
          [row.partition_no, result.position.toString()],
        );
        throw new Error(
          `${result.reason} on partition ${row.partition_no} after ${result.position}: ${JSON.stringify(failed.rows)}`,
        );
      }
      if (result.envelopes === 0) break;
    }
  }

  expect([...seen].filter((type) => type.startsWith('com.rezics.community.')).sort()).toEqual(seenCommunity);
  expect([...seen].filter((type) => type.startsWith('com.rezics.content.')).sort()).toEqual(contentCreated);
  for (const type of [...seenCommunity, ...schemaOnly, ...contentCreated]) {
    for (const data of payloads.get(type) ?? []) rejectsExtra(type, data);
  }
  const accepted = payloads.get('com.rezics.community.space.address-claim-accepted.v1') ?? [];
  expect(accepted.some((data) => !Object.hasOwn(data, 'revisionId'))).toBe(true);
  expect(accepted.some((data) => Object.hasOwn(data, 'revisionId'))).toBe(true);
  const reserved = payloads.get('com.rezics.community.space.address-reserved.v1')?.[0];
  if (!reserved) throw new Error('missing reserved address payload');
  rejectsExtra('com.rezics.community.space.address-reservation-skipped.v1', reserved);
  const joined = payloads.get('com.rezics.community.realm.membership.v1')?.[0];
  if (!joined) throw new Error('missing membership payload');
  rejectsExtra('com.rezics.community.realm.membership.v1', { ...joined, role: null });
  const threadSchema = schemaOf('com.rezics.content.thread.created.v1');
  const postSchema = schemaOf('com.rezics.content.post.created.v1');
  const revisionSchema = schemaOf('com.rezics.content.revision.created.v1');
  expect(threadSchema).toBeDefined();
  expect(postSchema).toBeDefined();
  expect(revisionSchema).toBeDefined();
  expect(threadSchema).not.toBe(postSchema);
  expect(postSchema).not.toBe(revisionSchema);
  expect(threadSchema).not.toBe(revisionSchema);
}, 60_000);
