import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createAuthService } from '@rezics/auth';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { exportJWK, generateKeyPair } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import * as accessPorts from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import type { CommandAttempt } from '../../src/command/command.ts';
import {
  importMediaFromUrl,
  MediaImportConflictError,
  type MediaImportDependencies,
} from '../../src/content/media-import.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `media_import_fin_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
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

const root = '00000000-0000-8000-8000-000000000000';
const route = 42000;
const accountId = newId(42016);
const actions = ['media:import_from_url', 'source_fence:read'];
const routeKey = new Uint8Array(32).fill(7);
const sourceRoute = tupleRoute(routeKey, 'catalogue', '42');
const request: MediaImportRequest = {
  containerId: newId(route),
  sourceUrl: 'https://images.example.test/cover.jpg',
  credit: {
    rightsHolder: 'Artist',
    via: { name: 'Catalogue', url: 'https://catalogue.example.test/42' },
    license: 'LicenseRef-unknown',
    obligations: [],
  },
  provenance: {
    source: 'catalogue',
    external_id: '42',
    field_group: 'cover',
    record_revision: '3',
    digest: 'b'.repeat(64),
    converter_revision: '2',
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://catalogue.example.test/42' } },
        ],
      },
    ],
  },
};
let db: GrowthDatabase;
let authFixture: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let actor: AccountActor;
let deps: MediaImportDependencies;
let initialized = 0;
let finalized = 0;
let finalProof: 'original' | 'missing' | 'invalid' = 'original';
const parentCreation = accessPorts.parentCreationAuthorization;
const initialize = accessPorts.initializeResourceGrants;
const restorers: { mockRestore(): void }[] = [];
const context = (key = Bun.randomUUIDv7()) => ({
  deadline: Date.now() + 30000,
  idempotencyKey: key,
  requestId: Bun.randomUUIDv7(),
});

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1; // Independent anchors must release before the target checkout.
  authFixture = await cloneAuthDatabase();
  authPool = new Pool({ connectionString: authFixture.url });
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES($1,$2,'actor','pending',$2)`,
    [routeOf(accountId), accountId],
  );
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    alg: 'ES256',
    kid: 'media-finalize',
  };
  const issuer = 'https://media-finalize.auth.test';
  let provisioning = true;
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://api.rezics.test',
    secret: 'media-finalize-fixture-secret-at-least-thirty-two-characters',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const row = await readAccount(db.admin, routeOf(id)!, id);
        return (
          row && {
            accountId: id,
            kind: row.kind,
            state: row.state,
            authnEpoch: Number(row.minimumAuthnEpoch),
            automated: false,
            fenced: row.fenced,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (reference !== accountId || !provisioning) throw new Error('Invalid fixture provisioning');
        provisioning = false;
        return { accountId };
      },
    }),
  });
  await auth.internal.registerClient({ clientId: 'importer', firstParty: true, scopes: actions });
  await auth.internal.provisionPassword({
    authorization: accountId,
    email: 'importer@example.test',
    password: 'correct horse battery staple',
  });
  await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(accountId),
    accountId,
  ]);
  const post = (path: string, body: unknown, cookie = '') =>
    auth.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );
  const signin = await post('/signin', {
    account_id: accountId,
    password: 'correct horse battery staple',
    client_id: 'importer',
    scope: actions,
  });
  expect(signin.status).toBe(200);
  const issued = await post(
    '/token',
    {},
    signin.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
  );
  expect(issued.status).toBe(200);
  const access = accessPorts.createAccess({
    actions: new Map(
      [...actions, 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'].map((a) => [
        a,
        a === 'media:import_from_url'
          ? { anonymous: false as const, 'x-resource-types': ['content.media'] as const }
          : { anonymous: false as const },
      ]),
    ),
    auth: { ...auth.verifier, fetch: async (url, init) => auth.handler(new Request(url, init)) },
  });
  actor = await access.authenticate(((await issued.json()) as { access_token: string }).access_token, {
    pool: db.pool,
    deadline: Date.now() + 30000,
  });
  deps = {
    pool: db.pool,
    access,
    routeKey,
    clock: () => new Date(),
    fetchConfig: { allowedHosts: ['images.example.test'] },
  };
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_release)
    VALUES($1,$2,'schema:Book',$2,'seed')`,
    [route, request.containerId],
  );
  for (const action of actions) await grant(action);
  await db.admin.query(`INSERT INTO content.source_fences VALUES($1,'catalogue','42','cover',false,1)`, [sourceRoute]);
  // Observe and fault the actual shared port; never replace an authorization decision.
  restorers.push(
    spyOn(accessPorts, 'parentCreationAuthorization').mockImplementation((input) => {
      const base = parentCreation(input);
      let prepared: { attempt: CommandAttempt; proof: unknown };
      return {
        ...base,
        async prepare(attempt) {
          const proof = await base.prepare!(attempt);
          prepared = { attempt, proof };
          return proof;
        },
        async finalize(tx, attempt, proof) {
          finalized++;
          await base.finalize!(
            tx,
            attempt,
            finalProof === 'missing' ? undefined : finalProof === 'invalid' ? {} : proof,
          );
          expect(attempt).toBe(prepared.attempt);
          expect(proof).toBe(prepared.proof);
        },
      };
    }),
  );
  restorers.push(
    spyOn(accessPorts, 'initializeResourceGrants').mockImplementation(async (...args) => {
      initialized++;
      await initialize(...args);
    }),
  );
}, 60000);

afterAll(async () => {
  for (const restorer of restorers) restorer.mockRestore();
  await authPool?.end();
  await authFixture?.close();
  await db?.close();
});
async function grant(action: string) {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES(0,$1,$2,$3,'(,)',$2)`,
    [root, accountId, action],
  );
}
async function effects() {
  return (
    await db.admin.query(`SELECT
    (SELECT count(*)::int FROM content.media) media,
    (SELECT count(*)::int FROM access.resource_initialization) initialized,
    (SELECT count(*)::int FROM access.resource_role_grant) roles,
    (SELECT count(*)::int FROM core.receipt) receipts,
    (SELECT count(*)::int FROM core.outbox) events,
    (SELECT jsonb_agg(p ORDER BY partition_no) FROM core.partition p) partitions,
    (SELECT jsonb_agg(c ORDER BY context_id) FROM semantic.context c) contexts,
    (SELECT jsonb_agg(f ORDER BY route,source,external_id,field_group) FROM content.source_fences f) fences`)
  ).rows[0];
}
function assertAnchors(statements: readonly string[]) {
  const receipt = statements.findIndex((s) => /FROM core.receipt/.test(s));
  const fences = statements.flatMap((s, i) => (s.includes('FROM content.source_fences') ? [i] : []));
  expect(fences).toHaveLength(2);
  for (const index of fences) {
    expect(index).toBeLessThan(receipt);
    expect(statements.slice(index + 1, receipt)).toContain('COMMIT');
    expect(statements.slice(0, index).some((s) => s === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).toBe(true);
  }
  expect(statements.filter((s) => /minimum_authn_epoch::text AS "minimumAuthnEpoch"/.test(s))).toHaveLength(1);
  expect(statements.filter((s) => /UPDATE core.partition/.test(s))).toHaveLength(1);
  expect(
    statements.some((s) => /(?:INSERT INTO|UPDATE|DELETE FROM) (?:semantic.context|content.source_fences)/.test(s)),
  ).toBe(false);
}

test('composite native URL authorization forwards original creation proof to shared finalize and commits one media with grants', async () => {
  const before = await effects();
  const calls = [initialized, finalized];
  const result = await capture(db, () => importMediaFromUrl(deps, actor, request, context()));
  expect(result.value.replayed).toBe(false);
  expect(routeOf(result.value.value.mediaId)).toBe(route);
  expect(result.value.partition).toBe(partitionOf(route));
  expect([initialized, finalized]).toEqual(calls.map((n) => n + 1));
  assertAnchors(result.capture.statements);
  const after = await effects();
  for (const field of ['media', 'initialized', 'roles', 'receipts', 'events'])
    expect(after[field] - before[field]).toBe(1);
  expect(after.contexts).toEqual(before.contexts);
  expect(after.fences).toEqual(before.fences);
  expect(after.partitions.filter((p: { partition_no: number }) => p.partition_no !== partitionOf(route))).toEqual(
    before.partitions.filter((p: { partition_no: number }) => p.partition_no !== partitionOf(route)),
  );
  const id = result.value.value.mediaId;
  expect(
    (
      await db.admin.query(
        `SELECT m.state,m.container_id,i.resource_type,g.grant_role,g.subject_id
    FROM content.media m JOIN access.resource_initialization i ON (i.route,i.resource_id)=(m.route,m.media_id)
    JOIN access.resource_role_grant g ON (g.route,g.resource_id)=(m.route,m.media_id)
    WHERE m.route=$1 AND m.media_id=$2`,
        [route, id],
      )
    ).rows,
  ).toEqual([
    {
      state: 'reserved',
      container_id: request.containerId,
      resource_type: 'content.media',
      grant_role: 'content.media.owner',
      subject_id: accountId,
    },
  ]);
});

test('receipt replay performs no initializer/finalizer/body, revoked authority denies before receipt', async () => {
  const attempt = context();
  const first = await importMediaFromUrl(deps, actor, request, attempt);
  const before = await effects();
  const calls = [initialized, finalized];
  const replay = await capture(db, () => importMediaFromUrl(deps, actor, request, context(attempt.idempotencyKey)));
  expect(replay.value.value).toEqual(first.value);
  expect(replay.value.replayed).toBe(true);
  expect([initialized, finalized]).toEqual(calls);
  expect(
    replay.capture.statements.some((s) =>
      /INSERT INTO (?:content.media|access.resource_|core.outbox|core.receipt)/.test(s),
    ),
  ).toBe(false);
  expect(await effects()).toEqual(before);
  for (const action of actions) {
    await db.admin.query(
      'DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action=$3',
      [root, accountId, action],
    );
    const denied = await capture(db, async () => {
      await expect(importMediaFromUrl(deps, actor, request, context(attempt.idempotencyKey))).rejects.toBeInstanceOf(
        GrantDeniedError,
      );
    });
    expect(denied.capture.statements.some((s) => /FROM core.receipt/.test(s))).toBe(false);
    await grant(action);
  }
  await db.admin.query(
    `UPDATE content.source_fences SET taken_down=true,taken_down_at=now(),takedown_id=gen_random_uuid(),security_revision=2 WHERE route=$1`,
    [sourceRoute],
  );
  try {
    const denied = await capture(db, async () => {
      await expect(importMediaFromUrl(deps, actor, request, context(attempt.idempotencyKey))).rejects.toBeInstanceOf(
        MediaImportConflictError,
      );
    });
    expect(denied.capture.statements.some((s) => /FROM core.receipt/.test(s))).toBe(false);
  } finally {
    await db.admin.query(
      `UPDATE content.source_fences SET taken_down=false,taken_down_at=NULL,takedown_id=NULL,security_revision=3 WHERE route=$1`,
      [sourceRoute],
    );
  }
  expect([initialized, finalized]).toEqual(calls);
});

test('missing or invalid original creation proof rolls back every native effect through shared finalization', async () => {
  for (const fault of ['missing', 'invalid'] as const) {
    const before = await effects();
    const calls = [initialized, finalized];
    finalProof = fault;
    try {
      await expect(importMediaFromUrl(deps, actor, request, context())).rejects.toBeInstanceOf(GrantDeniedError);
    } finally {
      finalProof = 'original';
    }
    expect([initialized, finalized]).toEqual(calls.map((n) => n + 1));
    expect(await effects()).toEqual(before);
  }
});

test('actual native growth remains one-partition bounded at three informative scales', async () => {
  const report = await checkGrowth(db, {
    name: 'native composite media creation',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    async grow(database, scale, previous) {
      await seed(
        database,
        {
          name: 'media composite background',
          hotPartition: partitionOf(route),
          rows() {
            // Two rows per ordinal make every read relation informative at the first scale.
            const ids = [newId(route), newId(route)];
            const roots = [newId(0), newId(0)];
            const accounts = [newId(42016), newId(42016)];
            return {
              'access.account': accounts.map((id) => ({
                route: 42016,
                account_id: id,
                kind: 'actor',
                state: 'active',
                transaction_id: id,
              })),
              'access.membership_inverse': accounts.map((id) => ({
                route: 42016,
                account_id: id,
                kind: 'organization',
                group_id: id,
                reservation_id: id,
                transaction_id: id,
              })),
              'semantic.context': roots.map((id) => ({ route: 0, context_id: id, kind: 'community', labels: {} })),
              'semantic.subject': ids.map((id) => ({
                route,
                subject_id: id,
                type: 'schema:Book',
                recorded_transaction_id: id,
                current_release: 'seed',
              })),
              'content.source_fences': ids.map((id) => ({
                route: sourceRoute,
                source: 'catalogue',
                external_id: id,
                field_group: 'cover',
                taken_down: false,
                security_revision: 1,
              })),
              'content.media': ids.map((id) => ({
                route,
                media_id: id,
                container_id: request.containerId,
                uploader_id: accountId,
                reservation_request_id: id,
                purpose: 'post-image',
                media_type: 'image/jpeg',
                byte_count: 128,
                state: 'reserved',
                key: `m/${id}/original`,
                transaction_id: id,
              })),
              'content.media_variant': ids.map((id) => ({
                route,
                media_id: id,
                format: 'webp',
                width: 320,
                height: 320,
                media_type: 'image/webp',
                byte_count: 128,
                sha256: 'a'.repeat(64),
                key: `m/${id}/webp-320`,
                transaction_id: id,
              })),
              'access.resource_grant': ids.map((id) => ({
                route: 0,
                resource_id: root,
                subject_id: id,
                action: actions[0],
                valid: '(,)',
                transaction_id: id,
              })),
              'access.resource_denial': ids.map((id) => ({
                route: 0,
                resource_id: root,
                subject_id: id,
                action: actions[0],
                reason: 'resource',
                valid: '(,)',
                transaction_id: id,
              })),
              'access.resource_initialization': ids.map((id) => ({
                route,
                resource_id: id,
                resource_type: 'content.media',
                creator_id: accountId,
                initialized_at: new Date(),
              })),
              'access.resource_role_grant': ids.map((id) => ({
                route,
                resource_id: id,
                subject_id: accountId,
                grant_role: 'content.media.owner',
                valid: '(,)',
                transaction_id: id,
              })),
              'core.receipt': ids.map((id) => ({
                partition_no: partitionOf(route),
                principal_kind: 'account',
                principal_id: accountId,
                command_kind: 'content.media.importFromUrl',
                idempotency_key: id,
                request_digest: Buffer.alloc(32),
                epoch: 1,
                position: 1,
                transaction_id: id,
                response: {},
              })),
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    async operation() {
      await importMediaFromUrl(deps, actor, request, context());
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
  expect(new Set(report.samples.map((s) => s.cost.statements)).size).toBe(1);
  expect(new Set(report.samples.map((s) => s.cost.rows)).size).toBe(1);
  for (const { cost } of report.samples) {
    for (const [name, relation] of Object.entries(cost.relations!)) {
      if (name.startsWith('content.')) expect(relation.sequentialScans).toBe(0);
    }
    expect(cost.relations!['content.media']!.blocks).toBeGreaterThan(0);
    expect(cost.relations!['content.source_fences']!.blocks).toBeGreaterThan(0);
  }
}, 120000);
