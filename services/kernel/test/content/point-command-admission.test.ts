import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { takedown, erasePost, eraseStandaloneMedia } from '../../src/content/moderation.ts';
import { beginAuthorErasure } from '../../src/content/operations.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

let db: GrowthDatabase;
const statements: { text: string; values?: unknown[] }[] = [];
const actorRead = (text: string) => text.includes('minimum_authn_epoch::text AS "minimumAuthnEpoch"');
const modes = ['takedown', 'post', 'media', 'author'] as const;
type Mode = (typeof modes)[number];
const route = 0x6931;
const actorRoute = 0x7931;
const actions = ['moderation:takedown', 'post:erase', 'media:erase'];
const issuer = 'https://content-admission.example.test';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: object;
let fetches = 0;
let retry = false;
const scopes = [...actions, 'account:read'];
const audience = 'https://api.example.test';
let access: Access;
let permissionKernel: ReturnType<typeof createKernel>;
let permissionPool: ReturnType<typeof createPool>;
let governanceBearer: string;
let lifecycle: ReturnType<typeof createLifecycleInternals>;
beforeAll(async () => {
  keys = await generateKeyPair('ES256');
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'ES256' }] };
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  // Fixture grants go through the public grant routes on their own uninstrumented pool.
  permissionPool = createPool(db.url);
  permissionKernel = createKernel({
    pool: permissionPool,
    routeKey: new Uint8Array(32).fill(93),
    access: () => access,
    writeRate: createWriteRateLimiter({
      secret: 'admission-fixture-write-rate-secret-32bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } }),
    }),
  });
  access = createAccess({
    actions: new Map([
      ...actionCatalogue(permissionKernel),
      ...actions.map((action) => [action, { anonymous: false }] as const),
    ]),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/jwks`,
      async fetch() {
        fetches++;
        return Response.json(jwks);
      },
    },
  });
  db.pool.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      const config = args[0] as unknown as string | { text: string; values?: unknown[] };
      const statement = typeof config === 'string' ? { text: config, values: args[1] as unknown[] } : config;
      statements.push(statement);
      if (
        retry &&
        (statement.text.includes('post_change AS') || statement.text.includes('INSERT INTO content.operation'))
      ) {
        retry = false;
        return Promise.reject(Object.assign(new Error('Serialization retry'), { code: '40001' }));
      }
      return query(...args);
    }) as PoolClient['query'];
  });
  const client = await db.pool.connect();
  client.release(true);
  // The first governance account comes from the operator bootstrap and holds Global access:grant.
  const governanceId = newId(actorRoute);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [actorRoute, governanceId],
  );
  await bootstrapGovernance(permissionPool, governanceId);
  lifecycle = createLifecycleInternals({
    pool: permissionPool,
    routeKey: new Uint8Array(32).fill(93),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  governanceBearer = await sign(governanceId, ['access:grant', ...actions]);
});
afterAll(async () => {
  await permissionPool?.end();
  await db?.close();
});

async function sign(accountId: string, scope: string[]) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: audience,
    sub: accountId,
    client_id: 'fixture',
    scope: scope.join(' '),
    authn_epoch: 9,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fixture' })
    .sign(keys.privateKey);
}

async function grant(resource: { route: number; id: string }, accountId: string, action: string) {
  const response = await permissionKernel.handle(
    new Request('https://content.test/v1/grants', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${governanceBearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({ resource, subject: { kind: 'account', id: accountId }, actions: [action], valid: '(,)' }),
    }),
  );
  if (!response.ok) throw new Error(`Fixture grant ${action}: ${response.status} ${await response.text()}`);
}

async function fixture() {
  const accountId = newId(actorRoute);
  const threadId = newId(route);
  const postId = newId(route);
  const mediaId = newId(route);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [actorRoute, accountId],
  );
  await db.admin.query(
    `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'thread','published',1,$2)`,
    [route, threadId, accountId, newId(route)],
  );
  const upperPostId = newId(route);
  for (const [post, at] of [
    [postId, '2000-01-01'],
    [upperPostId, '2020-01-01'],
  ])
    await db.admin.query(
      `WITH p AS (
       INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
       VALUES ($1,$2,$3,$4,$5,'published',1,$2,$6) RETURNING *
       ) INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       SELECT route,thread_id,post_id,head_revision_id,'private',sha256('private'::bytea),'private','CC0-1.0','{}',$2,'available',$2 FROM p`,
      [route, threadId, post, accountId, newId(route), at],
    );
  await db.admin.query(
    `INSERT INTO content.media(route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,state,key,transaction_id)
     VALUES ($1,$2::uuid,$3,$4,$2::text,'post-image','image/png',1,'reserved','m/'||$2::text||'/original',$3)`,
    [route, mediaId, threadId, accountId],
  );
  for (const [resource, action] of [
    [postId, actions[0]!],
    [postId, actions[1]!],
    [mediaId, actions[2]!],
  ] as const)
    await grant({ route, id: resource }, accountId, action);
  // Governance cannot grant account:read; an active account holds it from its own lifecycle.
  await lifecycle.installSelfReadGrant({ accountId, key: crypto.randomUUID() });
  // Component issuer exercises genuine JWT verification, not provisioning.
  const token = await sign(accountId, scopes);
  const context = { pool: db.pool, deadline: Date.now() + 180_000 };
  const actor = await access.authenticate(token, context);
  const deps = {
    pool: db.pool,
    access,
    routeKey: Buffer.alloc(32),
    clock: () => new Date(),
    workflows: {
      async enqueue() {
        throw new Error('Outbox only');
      },
      async status() {
        return null;
      },
    },
  };
  function execute(mode: Mode, key = crypto.randomUUID(), identity: AccountActor = actor, point = { postId, mediaId }) {
    const ctx = { deadline: context.deadline, idempotencyKey: key, requestId: newId(route) };
    if (mode === 'author') return beginAuthorErasure(deps, identity, { threadId, authorId: accountId }, ctx);
    if (mode === 'takedown')
      return takedown(deps, identity, { target: { kind: 'post', id: point.postId }, reason: 'fixture' }, ctx);
    if (mode === 'post') return erasePost(deps, identity, { postId: point.postId, reason: 'fixture' }, ctx);
    return eraseStandaloneMedia(deps, identity, { mediaId: point.mediaId, reason: 'fixture' }, ctx);
  }
  return { accountId, threadId, postId, upperPostId, mediaId, actor, token, context, execute };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function oneRead(f: Fixture, count = 1) {
  const reads = statements.filter(({ text }) => actorRead(text));
  expect(reads).toHaveLength(count);
  for (const read of reads) expect(read.values).toEqual([actorRoute, f.accountId]);
  const firstTarget = statements.findIndex(
    ({ text }) => text.includes('FROM content.') || text.includes('BEGIN ISOLATION LEVEL SERIALIZABLE'),
  );
  expect(statements.findIndex(({ text }) => actorRead(text))).toBeLessThan(firstTarget);
}
async function effects(f: Fixture) {
  return (
    await db.admin.query(
      `SELECT (SELECT row_to_json(p) FROM content.post p WHERE route=$1 AND post_id=$2) AS post,
     (SELECT row_to_json(m) FROM content.media m WHERE route=$1 AND media_id=$3) AS media,
     (SELECT count(*) FROM content.operation WHERE route=$1 AND initiator_account_id=$4) AS operations,
     (SELECT count(*) FROM core.receipt WHERE partition_no=$5 AND principal_id=$4) AS receipts,
     (SELECT position FROM core.partition WHERE partition_no=$5) AS position,
     (SELECT count(*) FROM core.outbox WHERE partition_no=$5) AS outbox`,
      [route, f.postId, f.mediaId, f.accountId, partitionOf(route)],
    )
  ).rows[0];
}
for (const mode of modes) {
  for (const mutation of [
    "state='suspended'",
    'authn_fenced=true',
    'minimum_authn_epoch=2',
    'operator_account_id=$3',
  ]) {
    test(`${mode}: old authenticated actor denies new command and same-key replay after ${mutation}`, async () => {
      const f = await fixture();
      const other = await fixture();
      const key = crypto.randomUUID();
      statements.length = 0;
      const initial = await f.execute(mode, key);
      expect(initial.replayed).toBe(false);
      expect(await f.execute(mode, key)).toEqual({ ...initial, replayed: true });
      const before = await effects(f);
      const jwksReads = fetches;
      await db.admin.query(
        `UPDATE access.account SET ${mutation} WHERE route=$1 AND account_id=$2`,
        mutation.includes('$3') ? [actorRoute, f.accountId, other.accountId] : [actorRoute, f.accountId],
      );
      for (const deniedKey of [crypto.randomUUID(), key]) {
        statements.length = 0;
        await expect(f.execute(mode, deniedKey)).rejects.toBeInstanceOf(GrantDeniedError);
        expect(statements.filter(({ text }) => actorRead(text))).toHaveLength(1);
        expect(
          statements.some(
            ({ text }) =>
              text.includes('FROM core.receipt') ||
              text.includes('FROM content.') ||
              text.includes('INSERT INTO content.'),
          ),
        ).toBe(false);
        expect(await effects(f)).toEqual(before);
      }
      expect((await other.execute(mode)).replayed).toBe(false);
      expect(fetches).toBe(jwksReads);
      // Keep the original actor and bearer throughout; no HTTP reauthentication.
      expect(f.actor.authnEpoch).toBe(9);
      expect(f.token).toBeTruthy();
    });
  }
  test(`${mode}: native serialization retry obtains a fresh shared account observation`, async () => {
    const f = await fixture();
    statements.length = 0;
    retry = true;
    try {
      expect((await f.execute(mode)).replayed).toBe(false);
    } finally {
      retry = false;
    }
    oneRead(f, 2);
    const proofs = statements.filter(({ text }) => text.includes('AS evidence_valid') || text.includes('AS allowed'));
    const times = proofs.flatMap(({ values = [] }) =>
      values.filter((value) => typeof value === 'string' && /^\d{4}-\d\d-\d\d .*\+00$/.test(value)),
    );
    expect(new Set(times).size).toBeGreaterThanOrEqual(2);
  });
}

test('shared admission and native point/author commands stay bounded at three population scales', async () => {
  // Every warm-up and sample owns a fresh post, media and author/thread scope.
  // Takedown and erasure see the same transitions at every scale.
  const targets: Fixture[] = [];
  for (let run = 0; run < 12; run++) targets.push(await fixture());
  const f = targets[0]!;
  const population: Population = {
    name: 'point-command-admission',
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const target = targets[ordinal % targets.length]!;
      const rows: Record<string, Record<string, unknown>[]> = {};
      const add = (table: string, row: Record<string, unknown>) => (rows[table] ??= []).push(row);
      // Two rows per logical unit put every read relation above 500 at scale 256.
      for (let offset = 0; offset < 2; offset++) {
        const id = newId(route),
          account = newId(actorRoute),
          revision = newId(route);
        add('access.account', {
          route: actorRoute,
          account_id: account,
          kind: 'actor',
          state: 'active',
          transaction_id: account,
        });
        add('access.membership_inverse', {
          route: actorRoute,
          account_id: account,
          kind: 'organization',
          group_id: newId(actorRoute),
          reservation_id: newId(actorRoute),
          transaction_id: account,
        });
        for (const action of actions) {
          add('access.resource_grant', {
            route,
            resource_id: id,
            subject_id: f.accountId,
            action,
            valid: '(,)',
            transaction_id: id,
          });
          add('access.resource_denial', {
            route,
            resource_id: id,
            subject_id: f.accountId,
            action,
            reason: 'resource',
            valid: '(,)',
            transaction_id: id,
          });
        }
        add('access.resource_role_grant', {
          route,
          resource_id: id,
          subject_id: f.accountId,
          grant_role: 'platform.governance',
          valid: '(,)',
          transaction_id: id,
        });
        add('content.board', {
          route,
          board_id: id,
          subject_id: id,
          title: 'filler',
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: id,
        });
        add('content.thread', {
          route,
          thread_id: id,
          author_account_id: target.accountId,
          board_id: id,
          title: 'filler',
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: id,
        });
        add('content.post', {
          route,
          thread_id: target.threadId,
          post_id: id,
          author_account_id: target.accountId,
          head_revision_id: revision,
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: id,
          created_at: '2001-01-01',
        });
        add('content.revision', {
          route,
          thread_id: target.threadId,
          post_id: id,
          revision_id: revision,
          body: Buffer.from('private'),
          body_sha256: createHash('sha256').update('private').digest(),
          search_text: 'private',
          licence: 'CC0-1.0',
          subject_ids: [],
          board_id: id,
          availability: 'available',
          recorded_transaction_id: id,
        });
        add('content.revision', {
          ...rows['content.revision']!.at(-1)!,
          post_id: target.postId,
          revision_id: newId(route),
        });
        add('content.media', {
          route,
          media_id: id,
          container_id: target.threadId,
          uploader_id: target.accountId,
          reservation_request_id: id,
          purpose: 'post-image',
          media_type: 'image/png',
          byte_count: 1,
          state: 'reserved',
          key: `m/${id}/original`,
          transaction_id: id,
        });
        add('core.receipt', {
          partition_no: partitionOf(route),
          principal_kind: 'account',
          principal_id: f.accountId,
          command_kind: 'content.post:erase',
          idempotency_key: `history-${ordinal}-${offset}`,
          request_digest: Buffer.alloc(32),
          epoch: 1,
          position: 1,
          transaction_id: id,
          response: {},
        });
      }
      return rows;
    },
  };
  const jwksReads = fetches;
  const report = await checkGrowth(db, {
    name: 'Authenticated content command admission',
    rule: 'series',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous, to: scale });
    },
    async operation(_database, _scale, repetition) {
      const f = targets[repetition]!;
      for (const mode of modes) {
        statements.length = 0;
        const result = await f.execute(mode, crypto.randomUUID());
        expect(result.replayed).toBe(false);
        oneRead(f);
        expect(statements.some(({ text }) => text.includes('FROM content.revision'))).toBe(false);
        if ('operationId' in result.value) {
          expect(
            (
              await db.admin.query('SELECT upper_post_id FROM content.operation WHERE route=$1 AND operation_id=$2', [
                route,
                result.value.operationId,
              ])
            ).rows[0].upper_post_id,
          ).toBe(f.upperPostId);
        }
      }
      expect(fetches).toBe(jwksReads);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(report.samples[0]!.cost.statements);
    expect(cost.relations).toBeDefined();
    expect(cost.relations?.['content.revision']).toBeUndefined();
    for (const [name, relation] of Object.entries(cost.relations!))
      if (name.startsWith('content.')) expect(relation.sequentialScans).toBe(0);
  }
}, 120_000);
