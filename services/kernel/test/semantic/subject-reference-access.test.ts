import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createResourcePublicEligibility } from '../../src/access/eligibility.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { accessCheck, type AccessClient, type Resource } from '../../src/request/access.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import { mergeSubjects, SubjectRedirectError } from '../../src/semantic/merges.ts';
import { readSubjectReference } from '../../src/semantic/references.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { actorFixture, type ActorFixture } from '../access/actor-side-fixture.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { createRealAccess } from './real-access.ts';

const pool = createPool(process.env.DATABASE_URL!);
const admin = createPool(process.env.DATABASE_URL!);
beforeAll(() => bootstrapRelease(pool, bundledRelease));
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function subject(f: ActorFixture, target = f.resource) {
  return createSubject(pool, {
    actor: f.actor,
    target,
    idempotencyKey: randomUUID(),
    digest: new Uint8Array(32),
    item: { type: 'schema:Book', labels: { en: 'Native reference' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
}

// Every observed statement still executes through pg, including Access and eligibility.
async function observed<T>(operation: () => Promise<T>) {
  const observer = observeSql(pool);
  try {
    return await operation();
  } finally {
    await observer.close();
    expect(
      observer.records.filter(({ statement }) =>
        /core\.consumer_checkpoint|semantic\.(?:fact|outbound_link\w*|inbound_link\w*|merge_member|definition\w*|summary\w*|revision|candidate|adoption|acceptance)\b|projection_pending/i.test(
          statement,
        ),
      ),
    ).toHaveLength(0);
    const ids = observer.records.map((record) => record.connectionId);
    if (ids.length) {
      expect(ids.every((id) => id !== undefined)).toBe(true);
      expect(new Set(ids).size).toBe(1);
    }
  }
}

async function check(f: ActorFixture, resource: Resource = f.resource) {
  return f.prepare(f.actor, f.permissions(), resource);
}

test('authenticated installed Access checks references against real grants and revocation', async () => {
  const f = await actorFixture(pool, admin);
  await subject(f);
  const real = await createRealAccess(admin, { reader: newId(4112) }, ['subject:read']);
  const access = real.access({ actions: new Map([['subject:read', { anonymous: false }]]) });
  const context = { pool, deadline: Date.now() + 5000 };
  const actor = await access.authenticate(real.bearer('reader'), context);
  const resource = { ...f.resource, eligibility: subjectReadEligibility(f.resource) };
  const prepare = () => accessCheck(access, actor, 'subject:read', resource, context);
  const denied = await prepare();
  expect(await observed(() => readSubjectReference(pool, f.resource.id, (client) => denied(client)))).toBeNull();
  await real.grant(f.resource, 'reader', 'subject:read');
  const allowed = await prepare();
  expect(await observed(() => readSubjectReference(pool, f.resource.id, (client) => allowed(client)))).toHaveProperty(
    'id',
    f.resource.id,
  );
  await real.revoke(f.resource, 'reader', 'subject:read');
  expect(await observed(() => readSubjectReference(pool, f.resource.id, (client) => allowed(client)))).toBeNull();
  expect(real.readChecks).toHaveLength(3);
});

test('reference identity and Access share one RR client and preserve native acceptance time', async () => {
  const f = await actorFixture(pool, admin);
  const created = await subject(f);
  const databaseAt = (await admin.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const ahead = new Date(databaseAt.getTime() + 30_000);
  await admin.query(
    `UPDATE access.resource_grant SET valid=tstzrange($4::timestamptz,NULL,'[)')
      WHERE route=$1 AND resource_id=$2 AND subject_id=$3`,
    [f.resource.route, f.resource.id, f.actorId, ahead],
  );
  let acceptanceAt: string | undefined;
  let authorizationClient: PoolClient | undefined;
  let eligibilityClient: AccessClient | undefined;
  const eligibility = createResourcePublicEligibility({
    resource: f.resource,
    action: 'subject:read',
    async prepare() {
      return { id: f.resource.id };
    },
    async verify({ client, at, evidence }) {
      eligibilityClient = client;
      expect(client).toBe(authorizationClient!);
      expect(at).toBe(acceptanceAt!);
      const row = await client.query('SELECT visibility FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
        f.resource.route,
        evidence.id,
      ]);
      return row.rows[0]?.visibility === 'visible';
    },
  });
  const ordinary = await check(f);
  expect(await observed(() => readSubjectReference(pool, f.resource.id, (client) => ordinary(client)))).toBeNull();
  const resource = { ...f.resource, eligibility };
  const authorize = await check(f, resource);
  // Native T exists only during its live command attempt. A separately anchored
  // reference read forwards it to Access on the reference's own RR client.
  const result = await runCommand(
    admin,
    { partition: partitionOf(f.resource.route), deadline: Date.now() + 5_000, clock: () => ahead },
    async (_, command) => {
      acceptanceAt = authoritativeTimeValue(command.time);
      expect(Date.parse(acceptanceAt)).toBeGreaterThan(databaseAt.getTime() + 20_000);
      const value = await observed(() =>
        readSubjectReference(pool, f.resource.id, async (client) => {
          authorizationClient = client;
          const state = await client.query('SHOW transaction_isolation');
          expect(state.rows[0]?.transaction_isolation).toBe('repeatable read');
          expect((await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only).toBe('on');
          return authorize(client, command.time);
        }),
      );
      return { value, events: [{ type: 'com.rezics.access.time-probe.v1', data: {} }] };
    },
  );
  expect(eligibilityClient).toBe(authorizationClient!);
  expect(result.value).toEqual({ id: f.resource.id, component: created.component });
});

test('references enforce current explicit denial, suspension and native visibility', async () => {
  const f = await actorFixture(pool, admin);
  await subject(f);
  const read = async () => {
    const authorize = await check(f);
    return observed(() => readSubjectReference(pool, f.resource.id, (client) => authorize(client)));
  };
  expect(await read()).toHaveProperty('id', f.resource.id);
  // A prepared check must still see a current denial on the RR resource client.
  const prepared = await check(f);
  await f.deny(f.actorId, '');
  expect(await observed(() => readSubjectReference(pool, f.resource.id, (client) => prepared(client)))).toBeNull();
  await admin.query('DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2', [
    f.resource.route,
    f.resource.id,
  ]);
  await admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(f.actorId),
    f.actorId,
  ]);
  expect(await read()).toBeNull();
  await admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(f.actorId),
    f.actorId,
  ]);
  for (const visibility of ['hidden', 'taken_down']) {
    await admin.query(
      'UPDATE semantic.subject SET visibility=$3, security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2',
      [f.resource.route, f.resource.id, visibility],
    );
    expect(await read()).toBeNull();
  }
  const authorize = await check(f);
  expect(
    await observed(() => readSubjectReference(pool, newId(f.resource.route), (client) => authorize(client))),
  ).toBeNull();
  expect(await observed(() => readSubjectReference(pool, 'invalid', (client) => authorize(client)))).toBeNull();
});

test('reference survivors in different partitions need fresh independent authorization after revocation', async () => {
  const f = await actorFixture(pool, admin);
  const target = { route: f.resource.route + 16, id: newId(f.resource.route + 16) };
  await subject(f, target);
  await subject(f);
  const [survivor, source] = [target, f.resource].sort((a, b) => a.id.localeCompare(b.id));
  expect(partitionOf(source!.route)).not.toBe(partitionOf(survivor!.route));
  await mergeSubjects(pool, {
    subjects: [source!.id, survivor!.id],
    survivor: survivor!.id,
    actor: f.actor,
    idempotencyKey: randomUUID(),
    digest: new Uint8Array(32),
    deadline: Date.now() + 5_000,
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: {
      action: 'subject:merge',
      resource: { route: 0, id: GLOBAL_CONTEXT },
      denied: () => new Error('Fixture denied'),
      async authorize() {
        return 'execute';
      },
    },
  });
  // Only the source is granted; its component cannot authorize the survivor.
  await admin.query('DELETE FROM access.resource_grant WHERE resource_id=$1', [f.resource.id]);
  await f.grant(f.actorId, '', source!);
  const sourceCheck = await check(f, source!);
  const redirect = await observed(() =>
    readSubjectReference(pool, source!.id, (client) => sourceCheck(client)).catch((error: unknown) => error),
  );
  expect(redirect).toBeInstanceOf(SubjectRedirectError);
  expect(redirect).toMatchObject({ from: source!.id, to: survivor!.id });
  const targetCheck = await check(f, survivor!);
  expect(await observed(() => readSubjectReference(pool, survivor!.id, (client) => targetCheck(client)))).toBeNull();
  await f.grant(f.actorId, '', survivor!);
  const granted = await check(f, survivor!);
  expect(await observed(() => readSubjectReference(pool, survivor!.id, (client) => granted(client)))).toHaveProperty(
    'component.partition',
    partitionOf(survivor!.route),
  );
  await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
    survivor!.route,
    survivor!.id,
  ]);
  // Even prepared evidence does not cache the resource grant decision.
  expect(await observed(() => readSubjectReference(pool, survivor!.id, (client) => granted(client)))).toBeNull();
  const fresh = await check(f, survivor!);
  expect(await observed(() => readSubjectReference(pool, survivor!.id, (client) => fresh(client)))).toBeNull();
  await f.deny(f.actorId, '');
  await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [source!.route, source!.id]);
  const denied = await check(f, source!);
  expect(await observed(() => readSubjectReference(pool, source!.id, (client) => denied(client)))).toBeNull();
});

test('reference visibility, eligibility and grant data use one repeatable snapshot', async () => {
  const f = await actorFixture(pool, admin);
  await subject(f);
  let clientUsed: AccessClient | undefined;
  const eligibility = createResourcePublicEligibility({
    resource: f.resource,
    action: 'subject:read',
    async prepare() {
      return true;
    },
    async verify({ client }) {
      expect(client).toBe(clientUsed!);
      const row = await client.query('SELECT visibility FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
        f.resource.route,
        f.resource.id,
      ]);
      return row.rows[0]?.visibility === 'visible';
    },
  });
  const authorize = await check(f, { ...f.resource, eligibility });
  const result = await observed(() =>
    readSubjectReference(pool, f.resource.id, async (client) => {
      clientUsed = client;
      await admin.query(
        "UPDATE semantic.subject SET visibility='hidden', security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
        [f.resource.route, f.resource.id],
      );
      await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
        f.resource.route,
        f.resource.id,
      ]);
      return authorize(client);
    }),
  );
  expect(result).toHaveProperty('id', f.resource.id);
  expect(await observed(() => readSubjectReference(pool, f.resource.id, (client) => authorize(client)))).toBeNull();
});

test('reference reads propagate expired deadlines and unavailable authorization', async () => {
  const f = await actorFixture(pool, admin);
  await subject(f);
  const authorize = await check(f);
  await expect(
    observed(() =>
      withRequestDeadline(Date.now() - 1, () =>
        readSubjectReference(pool, f.resource.id, (client) => authorize(client)),
      ),
    ),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
  const unavailable = new AccessUnavailableError('overloaded');
  await expect(
    observed(() =>
      readSubjectReference(pool, f.resource.id, async () => {
        throw unavailable;
      }),
    ),
  ).rejects.toBe(unavailable);
  const account = await readAccount(pool, routeOf(f.actorId)!, f.actorId);
  const context = { pool, account, deadline: Date.now() + 1000 };
  const expired = await accessCheck(f.permissions(), f.actor, 'subject:read', f.resource, context);
  await Bun.sleep(1010);
  await expect(
    observed(() => readSubjectReference(pool, f.resource.id, (client) => expired(client))),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
});
