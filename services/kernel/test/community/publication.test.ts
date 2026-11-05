import { AuthenticationError } from '../../src/request/access.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';
import { productionActions } from '../support/production-actions.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAccess } from '../../src/access/index.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { type AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const routeKey = new Uint8Array(32).fill(37);
const root = { route: 0, id: GLOBAL_CONTEXT };
const input = {
  title: 'First Realm',
  summary: 'A community',
  visibility: 'protected' as const,
  contextId: GLOBAL_CONTEXT,
};
const context = (idempotencyKey: string = randomUUID()) => ({ idempotencyKey, deadline: Date.now() + 90_000 });
const readContext = (actor: AccountActor | { kind: 'anonymous' }) => ({ actor, deadline: Date.now() + 90_000 });

// Privileged setup only; commands use genuine Auth tokens and production Access.
async function fixture(pool: Pool, admin: Pool) {
  const url = new URL(process.env.DATABASE_URL!);
  const database = `community_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`;
  migrateAuth(url.href);
  const authPool = new Pool({ connectionString: url.href });
  const issuer = 'https://community.auth.test';
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'community',
  };
  const ids = [newId(0x1234), newId(0x2345)];
  const approvals = new Set(ids);
  const actions = [
    'space:create',
    'space:manage',
    'space:read',
    'realm:create',
    'realm:manage',
    'realm:read',
    'realm:publish',
    'context:read',
    'subject:read',
  ];
  const password = 'community test password with enough entropy';
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://community.api.test',
    secret: 'community-test-secret-with-at-least-32-bytes',
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
        if (!approvals.delete(reference)) throw new Error('Unknown fixture provisioning reference');
        return { accountId: reference };
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'community-test', firstParty: true, scopes: actions });
  const access = createAccess({
    actions: productionActions(),
    auth: {
      issuer,
      audience: 'https://community.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async (url, init) => auth.handler(new Request(url, init)),
    },
  });
  const actors: AccountActor[] = [];
  for (const id of ids) {
    await admin.query(
      "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','pending',$2)",
      [routeOf(id), id],
    );
    await auth.internal.provisionPassword({ authorization: id, email: `${id}@community.test`, password });
    await admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
    const signin = await auth.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${id}@community.test`, password, client_id: 'community-test', scope: actions }),
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
    const actor = await access.authenticate(token, { pool, deadline: Date.now() + 600_000 });
    if (actor.kind !== 'account') throw new Error('Auth did not issue an account actor');
    actors.push(actor);
  }
  async function grant(id: string, target = root, action = 'space:create') {
    await admin.query(
      "INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)'::tstzrange,$3) ON CONFLICT DO NOTHING",
      [target.route, target.id, id, action],
    );
  }
  return {
    access,
    actor: actors[0]!,
    other: actors[1]!,
    grant,
    async close() {
      await authPool.end();
      await dropTestDatabase(admin, database);
    },
  };
}

let pool: Pool;
let admin: Pool;
let f: Awaited<ReturnType<typeof fixture>>;
let realm: typeof import('../../src/community/realm.ts');
let space: typeof import('../../src/community/space.ts');
let publication: typeof import('../../src/community/publication.ts');
beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  pool.options.max = 1;
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  f = await fixture(pool, admin);
  space = await import('../../src/community/space.ts');
  realm = await import('../../src/community/realm.ts');
  publication = await import('../../src/community/publication.ts');
});
beforeEach(async () => {
  await admin.query(
    'TRUNCATE community.publication_head, community.publication, community.realm, community.realm_revision, community.space, community.space_revision, access.resource_initialization, access.resource_role_grant, access.resource_grant, core.receipt, core.outbox, editorial.write_basis CASCADE',
  );
  await admin.query("UPDATE access.account SET state='active' WHERE account_id=ANY($1::uuid[])", [
    [f.actor.accountId, f.other.accountId],
  ]);
  await f.grant(f.actor.accountId);
});
afterAll(async () => {
  await f?.close();
  await pool?.end();
  await admin?.end();
});
const deps = () => ({ pool, access: f.access, routeKey });
async function createSpace() {
  return (await space.createSpace(deps(), f.actor, { title: 'Host Space' }, context())).value.spaceId;
}
async function createRealm(visibility: 'public' | 'protected' = 'protected') {
  const spaceId = await createSpace();
  await f.grant(f.actor.accountId, root, 'realm:create');
  const created = await realm.createRealm(deps(), f.actor, { ...input, spaceId, visibility }, context());
  const realmId = created.value.realmId;
  await f.grant(f.actor.accountId, { route: routeOf(realmId)!, id: realmId }, 'realm:publish');
  return { realmId, revisionId: created.value.revisionId, route: routeOf(realmId)! };
}
async function insertSubject(route = 0x4321) {
  const subjectId = newId(route);
  await admin.query(
    "INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id) VALUES ($1,$2,'schema:Book',$2)",
    [route, subjectId],
  );
  return subjectId;
}
async function counts() {
  return (
    await admin.query(`SELECT
      (SELECT count(*)::integer FROM community.publication) AS records,
      (SELECT count(*)::integer FROM community.publication_head) AS heads,
      (SELECT count(*)::integer FROM access.resource_grant) AS grants,
      (SELECT count(*)::integer FROM access.resource_initialization) AS initialized,
      (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
      (SELECT count(*)::integer FROM semantic.subject) AS subjects,
      (SELECT count(*)::integer FROM semantic.revision) AS revisions,
      (SELECT count(*)::integer FROM semantic.fact) AS facts,
      (SELECT count(*)::integer FROM semantic.context) AS contexts,
      (SELECT count(*)::integer FROM core.receipt) AS receipts,
      (SELECT count(*)::integer FROM core.outbox) AS events,
      (SELECT sum(position)::text FROM core.partition) AS position`)
  ).rows[0];
}
async function slot(realmId: string, subjectId: string) {
  return (
    await admin.query(
      `SELECT h.publication_id, h.verdict, p.predecessor, p.subject_revision_id, p.actor,
              p.xmin::text = h.xmin::text AS same_transaction
       FROM community.publication_head h
       JOIN community.publication p ON p.route = h.route AND p.publication_id = h.publication_id
       WHERE h.realm_id = $1 AND h.subject_id = $2`,
      [realmId, subjectId],
    )
  ).rows[0] as
    | {
        publication_id: string;
        verdict: string;
        predecessor: string | null;
        subject_revision_id: string | null;
        actor: string;
        same_transaction: boolean;
      }
    | undefined;
}

test("a Realm moderator publishes an existing subject into the Realm's single slot for it, and withdraw or reject moves the same head", async () => {
  const { realmId, route } = await createRealm();
  const subjectId = await insertSubject();
  const request = context();
  const adopted = await publication.publish(deps(), f.actor, { realmId, subjectId }, request);
  expect(adopted.partition).toBe(partitionOf(route));
  expect(routeOf(adopted.value.publicationId)).toBe(route);
  expect(adopted.value).toMatchObject({
    realmId,
    subjectId,
    verdict: 'adopt',
    predecessor: null,
    subjectRevisionId: null,
  });
  expect(await slot(realmId, subjectId)).toMatchObject({
    publication_id: adopted.value.publicationId,
    verdict: 'adopt',
    predecessor: null,
    subject_revision_id: null,
    actor: f.actor.accountId,
    same_transaction: true,
  });
  expect(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM community.publication_head WHERE realm_id=$1 AND subject_id=$2',
        [realmId, subjectId],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  const beforeReplay = await counts();
  expect(await publication.publish(deps(), f.actor, { realmId, subjectId }, context(request.idempotencyKey))).toEqual({
    ...adopted,
    replayed: true,
  });
  expect(await counts()).toEqual(beforeReplay);
  const withdrawn = await publication.withdraw(
    deps(),
    f.actor,
    { realmId, subjectId, expectedHead: adopted.value.publicationId },
    context(),
  );
  expect(withdrawn.value).toMatchObject({
    verdict: 'withdraw',
    predecessor: adopted.value.publicationId,
    subjectRevisionId: null,
  });
  expect(withdrawn.value.publicationId).not.toBe(adopted.value.publicationId);
  expect(await slot(realmId, subjectId)).toMatchObject({
    publication_id: withdrawn.value.publicationId,
    verdict: 'withdraw',
    predecessor: adopted.value.publicationId,
    same_transaction: true,
  });
  expect(await publication.readPublication(deps(), realmId, subjectId, readContext(f.actor))).toBeNull();
  expect((await publication.listPublications(deps(), realmId, readContext(f.actor), { limit: 10 }))!.items).toEqual([]);
  const rejected = await publication.reject(
    deps(),
    f.actor,
    { realmId, subjectId, expectedHead: withdrawn.value.publicationId },
    context(),
  );
  expect(rejected.value).toMatchObject({ verdict: 'reject', predecessor: withdrawn.value.publicationId });
  expect(await slot(realmId, subjectId)).toMatchObject({
    publication_id: rejected.value.publicationId,
    verdict: 'reject',
  });
  expect(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM community.publication_head WHERE realm_id=$1 AND subject_id=$2',
        [realmId, subjectId],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  expect(
    (
      await admin.query(
        'SELECT count(*)::integer AS n FROM community.publication WHERE realm_id=$1 AND subject_id=$2',
        [realmId, subjectId],
      )
    ).rows,
  ).toEqual([{ n: 3 }]);
  const again = await publication.publish(
    deps(),
    f.actor,
    { realmId, subjectId, expectedHead: rejected.value.publicationId },
    context(),
  );
  expect(await publication.readPublication(deps(), realmId, subjectId, readContext(f.actor))).toMatchObject({
    realmId,
    subjectId,
    publicationId: again.value.publicationId,
    verdict: 'adopt',
    subjectRevisionId: null,
  });
  for (const query of [
    "UPDATE community.publication SET verdict='adopt' WHERE publication_id=$1",
    'DELETE FROM community.publication WHERE publication_id=$1',
  ])
    expect(await admin.query(query, [adopted.value.publicationId]).catch((error) => error)).toMatchObject({
      code: '23514',
    });
});

test('publishing grants nothing on the subject or the Global Context, and a non-moderator, suspended account, missing subject or stale head writes nothing', async () => {
  const { realmId, route } = await createRealm();
  const subjectId = await insertSubject();
  const otherSubject = await insertSubject(0x2222);
  const before = await counts();
  const adopted = await publication.publish(deps(), f.actor, { realmId, subjectId }, context());
  const after = await counts();
  expect(after.records).toBe(before.records + 1);
  expect(after.heads).toBe(before.heads + 1);
  expect(after.receipts).toBe(before.receipts + 1);
  expect(after.events).toBe(before.events + 1);
  expect(after.grants).toBe(before.grants);
  expect(after.initialized).toBe(before.initialized);
  expect(after.roles).toBe(before.roles);
  expect(after.subjects).toBe(before.subjects);
  expect(after.revisions).toBe(before.revisions);
  expect(after.facts).toBe(before.facts);
  expect(after.contexts).toBe(before.contexts);
  for (const resource of [subjectId, otherSubject, GLOBAL_CONTEXT]) {
    expect(
      (
        await admin.query(
          'SELECT count(*)::integer AS n FROM access.resource_grant WHERE resource_id=$1 AND action LIKE $2',
          [resource, 'subject:%'],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (
        await admin.query('SELECT count(*)::integer AS n FROM access.resource_initialization WHERE resource_id=$1', [
          resource,
        ])
      ).rows,
    ).toEqual(resource === GLOBAL_CONTEXT ? expect.any(Array) : [{ n: 0 }]);
  }
  expect(
    (
      await admin.query(
        "SELECT count(*)::integer AS n FROM access.resource_grant WHERE resource_id=$1 AND action='realm:publish'",
        [GLOBAL_CONTEXT],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  expect(
    (await admin.query('SELECT count(*)::integer AS n FROM access.resource_grant WHERE resource_id=$1', [subjectId]))
      .rows,
  ).toEqual([{ n: 0 }]);

  const untouched = async (run: () => Promise<unknown>) => {
    const snapshot = await counts();
    const error = await run().catch((cause) => cause);
    expect(await counts()).toEqual(snapshot);
    return error;
  };
  expect(
    await untouched(() => publication.publish(deps(), f.other, { realmId, subjectId: otherSubject }, context())),
  ).toBeInstanceOf(GrantDeniedError);
  expect(
    await untouched(() => publication.publish(deps(), f.actor, { realmId, subjectId: newId(route) }, context())),
  ).toBeInstanceOf(GrantDeniedError);
  expect(
    await untouched(() =>
      publication.publish(deps(), f.actor, { realmId, subjectId, expectedHead: newId(route) }, context()),
    ),
  ).toBeInstanceOf(publication.PublicationConflictError);
  expect(await untouched(() => publication.publish(deps(), f.actor, { realmId, subjectId }, context()))).toBeInstanceOf(
    publication.PublicationConflictError,
  );
  expect(
    await untouched(() =>
      publication.withdraw(deps(), f.actor, { realmId, subjectId, expectedHead: newId(route) }, context()),
    ),
  ).toBeInstanceOf(publication.PublicationConflictError);
  await suspendAccount(admin, f.actor.accountId);
  expect(
    await untouched(() =>
      publication.reject(deps(), f.actor, { realmId, subjectId, expectedHead: adopted.value.publicationId }, context()),
    ),
  ).toBeInstanceOf(AuthenticationError);
  expect(await slot(realmId, subjectId)).toMatchObject({
    publication_id: adopted.value.publicationId,
    verdict: 'adopt',
  });
});

test("a Realm's publication list is a keyset page whose every item passes final disclosure", async () => {
  const { realmId, revisionId } = await createRealm();
  const subjects = [await insertSubject(0x3100), await insertSubject(0x3200), await insertSubject(0x3300)];
  const published = [];
  for (const subjectId of subjects)
    published.push(await publication.publish(deps(), f.actor, { realmId, subjectId }, context()));
  const owner = readContext(f.actor);
  const first = await publication.listPublications(deps(), realmId, owner, { limit: 2 });
  expect(first!.items).toHaveLength(2);
  expect(
    first!.items.every(
      (item) => item.verdict === 'adopt' && item.subjectRevisionId === null && item.realmId === realmId,
    ),
  ).toBe(true);
  expect(first!.next).toBeString();
  const second = await publication.listPublications(deps(), realmId, owner, { cursor: first!.next!, limit: 2 });
  expect(second!.items).toHaveLength(1);
  expect(second!.next).toBeNull();
  expect(first!.items[0]!.publishedAt >= first!.items[1]!.publishedAt).toBe(true);
  expect(first!.items[1]!.publishedAt >= second!.items[0]!.publishedAt).toBe(true);
  const seen = [...first!.items, ...second!.items].map((item) => item.publicationId);
  expect(new Set(seen)).toEqual(new Set(published.map((row) => row.value.publicationId)));
  await Bun.sleep(5);
  const newest = await publication.publish(
    deps(),
    f.actor,
    { realmId, subjectId: await insertSubject(0x3400) },
    context(),
  );
  const continued = await publication.listPublications(deps(), realmId, owner, { cursor: first!.next!, limit: 2 });
  const firstIds = new Set(first!.items.map((item) => item.publicationId));
  expect(continued!.items.every((item) => !firstIds.has(item.publicationId))).toBe(true);
  expect(continued!.items.some((item) => item.publicationId === newest.value.publicationId)).toBe(false);
  const refreshed = await publication.listPublications(deps(), realmId, owner, { limit: 1 });
  expect(refreshed!.items[0]!.publicationId).toBe(newest.value.publicationId);
  expect(await publication.listPublications(deps(), realmId, readContext(f.other), { limit: 10 })).toBeNull();
  expect(
    await publication.listPublications(deps(), realmId, readContext({ kind: 'anonymous' }), { limit: 10 }),
  ).toBeNull();
  expect(await publication.readPublication(deps(), realmId, subjects[2]!, readContext(f.other))).toBeNull();
  await admin.query('DELETE FROM semantic.subject WHERE subject_id=$1', [subjects[1]]);
  const disclosed = await publication.listPublications(deps(), realmId, owner, { limit: 10 });
  expect(disclosed!.items.map((item) => item.subjectId)).not.toContain(subjects[1]);
  expect(new Set(disclosed!.items.map((item) => item.subjectId))).toEqual(
    new Set([subjects[2]!, subjects[0]!, newest.value.subjectId]),
  );
  expect(await publication.readPublication(deps(), realmId, subjects[1]!, owner)).toBeNull();
  await realm.updateRealm(deps(), f.actor, { realmId, expectedHead: revisionId, visibility: 'public' }, context());
  const anonymous = await publication.listPublications(deps(), realmId, readContext({ kind: 'anonymous' }), {
    limit: 10,
  });
  expect(anonymous!.items.map((item) => item.subjectId).sort()).toEqual(
    [subjects[2]!, subjects[0]!, newest.value.subjectId].sort(),
  );
  await realm.updateRealm(
    deps(),
    f.actor,
    {
      realmId,
      expectedHead: (await realm.readRealm(deps(), f.actor, realmId, { deadline: Date.now() + 5000 }))!.headRevisionId,
      visibility: 'protected',
    },
    context(),
  );
  expect(
    await publication.listPublications(deps(), realmId, readContext({ kind: 'anonymous' }), { limit: 10 }),
  ).toBeNull();
  expect(
    await publication
      .listPublications(deps(), realmId, owner, { cursor: 'not-a-cursor', limit: 2 })
      .catch((error) => error),
  ).toBeInstanceOf(publication.PublicationCursorError);
  await publication.withdraw(
    deps(),
    f.actor,
    { realmId, subjectId: subjects[2]!, expectedHead: published[2]!.value.publicationId },
    context(),
  );
  expect(
    (await publication.listPublications(deps(), realmId, owner, { limit: 10 }))!.items.map((item) => item.subjectId),
  ).not.toContain(subjects[2]);
  expect(await publication.readPublication(deps(), realmId, subjects[2]!, owner)).toBeNull();
});
