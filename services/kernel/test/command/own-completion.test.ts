import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  hasLiveCommandTransaction,
  hasOwnCommandCompletion,
  IdempotencyConflictError,
  CommandUnavailableError,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
  type PrincipalCommandReceipt,
} from '../../src/command/command.ts';
import { createResourceAnonymousEligibility } from '../../src/access/index.ts';
import {
  accessCheck,
  accessCommandAuthorization,
  type Actor,
  type AccountActor,
  type Resource,
} from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  capture,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import { testAccess } from '../support/test-kernel.ts';

let db: GrowthDatabase;
let access: ReturnType<typeof testAccess>;
let actor: AccountActor;
let other: AccountActor;
let restricted: AccountActor;
const action = 'subject:create';
const kind = 'test.own-completion';
const digest = new Uint8Array(32).fill(7);
const event = { type: 'com.rezics.test.happened.v1', data: {} };
const receipt = (key: string = randomUUID()): PrincipalCommandReceipt => ({ kind, key, digest });
class Denied extends Error {}

beforeAll(async () => {
  db = await openGrowthDatabase();
  const issuer = 'https://completion-auth.example.test';
  const audience = 'https://api.example.test';
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'completion', alg: 'ES256' };
  access = testAccess({
    pool: db.pool,
    actions: new Map([
      [action, { anonymous: false }],
      ['report:create', { anonymous: true }],
    ]),
    auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
  });
  async function authenticate(id: string, scope = action) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ client_id: 'web', scope, authn_epoch: 1, auth_time: now, amr: ['pwd'] })
      .setProtectedHeader({ alg: 'ES256', kid: 'completion', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(id)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    return access.authenticate(token, { pool: db.pool, deadline: Date.now() + 180_000 });
  }
  const ids = [newId(0xc100), newId(0xc110)];
  for (const id of ids)
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      VALUES($1,$2,'actor','active',$3)`,
      [routeOf(id), id, Bun.randomUUIDv7()],
    );
  actor = await authenticate(ids[0]!);
  other = await authenticate(ids[1]!);
  restricted = await authenticate(ids[0]!, 'account:read');
});
afterAll(async () => {
  await db?.close();
});

async function target(partition: number): Promise<Resource> {
  const resource = { route: partition << 4, id: newId(partition << 4) };
  for (const identity of [actor, other])
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES($1,$2,$3,$4,'(,)',$5)`,
      [resource.route, resource.id, identity.accountId, action, Bun.randomUUIDv7()],
    );
  return resource;
}
async function options(resource: Resource, identity: Actor = actor, selected = action) {
  return {
    ...principalCommandIdentity(identity),
    partition: resource.route >>> 4,
    authorization: await accessCommandAuthorization(
      access,
      identity,
      selected,
      resource,
      { pool: db.pool, deadline: Date.now() + 5000 },
      () => new Denied('original apply policy denied'),
    ),
  };
}
async function complete(resource: Resource, input = receipt(), legacy = false) {
  const native = await options(resource);
  const body = async () => ({ value: { secret: 'stored response' }, events: [event] });
  const result = legacy
    ? await runCommand(
        db.pool,
        {
          partition: native.partition,
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: null },
          authorization: native.authorization,
          receipt: { ...input, actorAccountId: actor.accountId },
        },
        body,
      )
    : await runCommand(db.pool, { ...native, receipt: input }, body);
  return { input, result };
}
async function lookup(resource: Resource, input: PrincipalCommandReceipt, identity: Actor = actor) {
  return runCommand(db.pool, await options(resource, identity), async (tx) =>
    noEffect(await hasOwnCommandCompletion(tx, input)),
  );
}
async function snapshot(partition: number) {
  return (
    await db.admin.query(
      `SELECT to_jsonb(p) AS head,
    (SELECT jsonb_agg(r ORDER BY principal_id,command_kind,idempotency_key) FROM core.receipt r WHERE partition_no=$1) AS receipts,
    (SELECT jsonb_agg(o ORDER BY position,event_seq) FROM core.outbox o WHERE partition_no=$1) AS events,
    (SELECT jsonb_agg(b ORDER BY transaction_id) FROM editorial.write_basis b WHERE partition_no=$1) AS basis
    FROM core.partition p WHERE partition_no=$1`,
      [partition],
    )
  ).rows;
}
const completionStatements = (statements: readonly string[]) =>
  statements.filter((sql) => /FROM core\.receipt/i.test(sql));

test('metadata-only own completion is native principal partition digest and authorized live transaction scoped without response access or receipt-order changes', async () => {
  const resource = await target(3100);
  const { input, result } = await complete(resource, receipt(), true);
  const before = await snapshot(3100);
  const otherHome = await target(3101);
  const measured = await capture(db, async () => {
    expect((await lookup(resource, input)).value).toBe(true);
    expect((await lookup(resource, receipt())).value).toBe(false);
    expect((await lookup(resource, { ...input, kind: `${kind}.other` })).value).toBe(false);
    expect((await lookup(resource, input, other)).value).toBe(false);
    expect((await lookup(otherHome, input)).value).toBe(false);
    await expect(lookup(resource, { ...input, digest: new Uint8Array(32).fill(8) })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });
  const statements = completionStatements(measured.capture.statements);
  expect(statements).toHaveLength(6);
  for (const sql of statements) {
    expect(sql.replace(/\s+/g, ' ').trim()).toMatch(
      /^SELECT request_digest AS "requestDigest" FROM core.receipt WHERE /,
    );
    expect(sql).not.toMatch(/response|position|epoch|transaction_id|JOIN/i);
    for (const field of ['partition_no', 'principal_kind', 'principal_id', 'command_kind', 'idempotency_key'])
      expect(sql).toContain(`${field} =`);
  }
  expect(await snapshot(3100)).toEqual(before);
  // Ordinary principal API replay still reads the response and retains the original commit identity.
  const replay = await runCommand(
    db.pool,
    { ...(await options(resource)), receipt: input },
    async (): Promise<never> => {
      throw new Error('Replay ran body');
    },
  );
  expect(replay).toEqual({ ...result, replayed: true });
  expect(await snapshot(3100)).toEqual(before);
});

test('matching completion survives minimized response and validates native key, digest and kind before SQL', async () => {
  const resource = await target(3102);
  const { input } = await complete(resource, receipt('x'.repeat(255)));
  await db.admin.query(`UPDATE core.receipt SET response=$3::jsonb WHERE partition_no=$1 AND idempotency_key=$2`, [
    3102,
    input.key,
    JSON.stringify({ large: 'private payload '.repeat(100_000) }),
  ]);
  const large = await capture(db, () => lookup(resource, input));
  await db.admin.query(`UPDATE core.receipt SET response='null'::jsonb WHERE partition_no=$1 AND idempotency_key=$2`, [
    3102,
    input.key,
  ]);
  const minimized = await capture(db, () => lookup(resource, input));
  expect(large.value.value).toBe(true);
  expect(minimized.value.value).toBe(true);
  const metadataBytes = (value: typeof large) =>
    value.capture.responseBytes![value.capture.statements.findIndex((sql) => sql.includes('FROM core.receipt'))];
  expect(metadataBytes(large)).toBe(32);
  expect(metadataBytes(large)).toBe(metadataBytes(minimized));
  const invalid = [
    { ...input, key: '' },
    { ...input, key: 'x'.repeat(256) },
    { ...input, key: 1 },
    { ...input, digest: new Uint8Array(31) },
    { ...input, digest: new Uint8Array(33) },
    { ...input, digest: Array(32).fill(7) },
    { ...input, kind: null },
  ];
  const native = await options(resource);
  const measured = await capture(db, () =>
    runCommand(db.pool, native, async (tx) => {
      for (const value of invalid)
        await expect(hasOwnCommandCompletion(tx, value as PrincipalCommandReceipt)).rejects.toBeInstanceOf(TypeError);
      expect(await hasOwnCommandCompletion(tx, { ...input, key: 'x' })).toBe(false);
      expect(await hasOwnCommandCompletion(tx, { ...input, kind: '' })).toBe(false);
      return noEffect(null);
    }),
  );
  expect(completionStatements(measured.capture.statements)).toHaveLength(2);
}, 10_000);

test('original apply action/resource policy denies before every lookup including existing completion', async () => {
  const resource = await target(3103);
  const { input } = await complete(resource);
  const before = await snapshot(3103);
  await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    resource.route,
    resource.id,
    actor.accountId,
  ]);
  const measured = await capture(db, async () => {
    await expect(lookup(resource, input)).rejects.toBeInstanceOf(Denied);
    await expect(lookup(resource, input, restricted)).rejects.toBeInstanceOf(Denied);
    await expect(
      runCommand(db.pool, await options(resource, other, 'unknown:create'), async (tx) =>
        noEffect(await hasOwnCommandCompletion(tx, input)),
      ),
    ).rejects.toBeInstanceOf(Denied);
  });
  expect(completionStatements(measured.capture.statements)).toEqual([]);
  expect(await snapshot(3103)).toEqual(before);
});

test('pooled, prepare, before authorization, copied, rolled back, committed and identity-free contexts reject without SQL', async () => {
  const resource = await target(3104);
  const { input } = await complete(resource);
  const native = await options(resource);
  let saved: CommandTransaction | undefined;
  let prepared = false;
  let authorized = false;
  const authorization: CommandAuthorization = {
    ...native.authorization,
    async prepare(attempt) {
      prepared = true;
      await expect(hasOwnCommandCompletion(db.pool, input)).rejects.toBeInstanceOf(TypeError);
      return native.authorization.prepare!(attempt);
    },
    async authorize(tx, attempt, evidence) {
      expect(hasLiveCommandTransaction(tx)).toBe(true);
      await expect(hasOwnCommandCompletion(tx, input)).rejects.toBeInstanceOf(TypeError);
      const mode = await native.authorization.authorize(tx, attempt, evidence);
      // Even a callback's successful permission result is not executor-issued authority yet.
      await expect(hasOwnCommandCompletion(tx, input)).rejects.toBeInstanceOf(TypeError);
      authorized = true;
      return mode;
    },
  };
  const measured = await capture(db, async () => {
    const client = await db.pool.connect();
    try {
      await expect(hasOwnCommandCompletion(client, input)).rejects.toBeInstanceOf(TypeError);
    } finally {
      client.release();
    }
    await runCommand(db.pool, { ...native, authorization }, async (tx) => {
      saved = tx;
      const copy = Object.create(Object.getPrototypeOf(tx), Object.getOwnPropertyDescriptors(tx)) as CommandTransaction;
      expect(hasLiveCommandTransaction(copy)).toBe(true);
      await expect(hasOwnCommandCompletion(copy, input)).rejects.toBeInstanceOf(TypeError);
      await expect(hasOwnCommandCompletion({ query: tx.query }, input)).rejects.toBeInstanceOf(TypeError);
      expect(await hasOwnCommandCompletion(tx, input)).toBe(true);
      return noEffect(null);
    });
    await expect(hasOwnCommandCompletion(saved!, input)).rejects.toBeInstanceOf(TypeError);
    const abort = new Error('abort native attempt');
    await expect(
      runCommand(db.pool, await options(resource), async (tx) => {
        saved = tx;
        throw abort;
      }),
    ).rejects.toBe(abort);
    await expect(hasOwnCommandCompletion(saved!, input)).rejects.toBeInstanceOf(TypeError);
    await runCommand(db.pool, await options(resource), async () => {
      await expect(hasOwnCommandCompletion(saved!, input)).rejects.toBeInstanceOf(TypeError);
      return noEffect(null);
    });
    // Legacy identity without authorization, and authorization without identity, carry no owner context.
    await runCommand(
      db.pool,
      { partition: 3104, basis: { actorAccountId: actor.accountId, clientId: 'web', requestedBy: null } },
      async (tx) => {
        await expect(hasOwnCommandCompletion(tx, input)).rejects.toBeInstanceOf(TypeError);
        return noEffect(null);
      },
    );
    const check = await accessCheck(access, actor, action, resource, { pool: db.pool, deadline: Date.now() + 5000 });
    await runCommand(
      db.pool,
      {
        partition: 3104,
        authorization: {
          action,
          resource,
          denied: () => new Denied(),
          async authorize(tx) {
            if (!(await check(tx))) throw new Denied();
            return 'execute';
          },
        },
      },
      async (tx) => {
        // Genuine Access action/resource authorization alone cannot invent a receipt principal.
        await expect(hasOwnCommandCompletion(tx, input)).rejects.toBeInstanceOf(TypeError);
        return noEffect(null);
      },
    );
  });
  expect(prepared).toBe(true);
  expect(authorized).toBe(true);
  expect(completionStatements(measured.capture.statements)).toHaveLength(1);
});

test('expired authorized attempt loses receipt authority before transaction exit', async () => {
  const resource = await target(3107);
  const { input } = await complete(resource);
  const native = await options(resource);
  let expired = false;
  const before = await snapshot(3107);
  const measured = await capture(db, async () => {
    await expect(
      runCommand(db.pool, { ...native, deadline: Date.now() + 1500 }, async (tx) => {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        expect(hasLiveCommandTransaction(tx)).toBe(true);
        await expect(hasOwnCommandCompletion(tx, input)).rejects.toBeInstanceOf(TypeError);
        expired = true;
        throw new Error('expired body rolls back');
      }),
    ).rejects.toBeInstanceOf(CommandUnavailableError);
  });
  expect(expired).toBe(true);
  expect(completionStatements(measured.capture.statements)).toEqual([]);
  expect(await snapshot(3107)).toEqual(before);
}, 10_000);

test('anonymous completion uses canonical UUIDv4 and native eligibility without a bypass', async () => {
  const route = 3105 << 4;
  const base = { route, id: newId(route) };
  await db.admin.query(
    `CREATE TABLE public.completion_anonymous_target(route integer, id uuid, admits boolean NOT NULL, PRIMARY KEY(route,id))`,
  );
  await db.admin.query('INSERT INTO public.completion_anonymous_target VALUES($1,$2,true)', [route, base.id]);
  const resource = {
    ...base,
    eligibility: createResourceAnonymousEligibility({
      resource: base,
      action: 'report:create',
      async prepare() {
        return { id: base.id };
      },
      async verify({ client, resource: selected, evidence }) {
        if (evidence.id !== selected.id) return false;
        return (
          (
            await client.query('SELECT admits FROM public.completion_anonymous_target WHERE route=$1 AND id=$2', [
              selected.route,
              selected.id,
            ])
          ).rows[0]?.admits === true
        );
      },
    }),
  };
  const anonymous: Actor = { kind: 'anonymous' };
  const input = receipt();
  const original = await runCommand(
    db.pool,
    { ...(await options(resource, anonymous, 'report:create')), receipt: input },
    async () => ({ value: { accepted: true }, events: [event] }),
  );
  const outer = receipt();
  const measured = await capture(db, async () => {
    await runCommand(
      db.pool,
      { ...(await options(resource, anonymous, 'report:create')), receipt: outer },
      async (tx) => {
        expect(await hasOwnCommandCompletion(tx, { ...input, key: input.key.toUpperCase() })).toBe(true);
        await expect(hasOwnCommandCompletion(tx, { ...input, key: 'account-only-key' })).rejects.toBeInstanceOf(
          TypeError,
        );
        await expect(hasOwnCommandCompletion(tx, { ...input, digest: new Uint8Array(32) })).rejects.toBeInstanceOf(
          IdempotencyConflictError,
        );
        return noEffect(null);
      },
    );
  });
  expect(completionStatements(measured.capture.statements)).toHaveLength(3); // outer replay check, then two metadata probes
  await db.admin.query('UPDATE public.completion_anonymous_target SET admits=false WHERE route=$1 AND id=$2', [
    route,
    base.id,
  ]);
  const denied = await capture(db, async () => {
    await expect(
      runCommand(db.pool, { ...(await options(resource, anonymous, 'report:create')), receipt: input }, async (tx) =>
        noEffect(await hasOwnCommandCompletion(tx, input)),
      ),
    ).rejects.toBeInstanceOf(Denied);
  });
  expect(completionStatements(denied.capture.statements)).toEqual([]);
  expect(original.replayed).toBe(false);
});

test('metadata completion has fixed rows, statements and bytes with logarithmic blocks at three legal receipt scales', async () => {
  const partition = 3106;
  const resource = await target(partition);
  const matching = await complete(resource);
  const minimized = await complete(resource);
  await db.admin.query(`UPDATE core.receipt SET response='null'::jsonb WHERE partition_no=$1 AND idempotency_key=$2`, [
    partition,
    minimized.input.key,
  ]);
  const missing = receipt();
  const population: Population = {
    name: 'own-completion-receipts',
    hotPartition: partition,
    hotShare: 1,
    rows({ ordinal, route }) {
      return {
        'core.receipt': [
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: actor.accountId,
            command_kind: kind,
            idempotency_key: `unrelated-${ordinal}`,
            request_digest: digest,
            epoch: 1,
            position: 0,
            transaction_id: newId(route),
            response: { unrelated: ordinal },
          },
        ],
      };
    },
  };
  const report = await checkGrowth(db, {
    name: 'Metadata-only own completion',
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous * 512, to: scale * 512 });
    },
    async operation() {
      await runCommand(db.pool, await options(resource), async (tx) => {
        expect(await hasOwnCommandCompletion(tx, matching.input)).toBe(true);
        expect(await hasOwnCommandCompletion(tx, missing)).toBe(false);
        await expect(
          hasOwnCommandCompletion(tx, { ...matching.input, digest: new Uint8Array(32) }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
        expect(await hasOwnCommandCompletion(tx, minimized.input)).toBe(true);
        return noEffect(null);
      });
      await expect(lookup(resource, matching.input, restricted)).rejects.toBeInstanceOf(Denied);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  for (const { cost } of report.samples) {
    expect(cost.relations['core.receipt']?.rows).toBe(3);
    expect(cost.relations['core.receipt']?.sequentialScans).toBe(0);
  }
  console.log(JSON.stringify({ name: report.name, samples: report.samples }));
}, 90_000);
