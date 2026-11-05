import { afterAll, beforeEach, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  createContentEditionBuyerFact,
  matchesContentEditionBuyerFact,
  type ContentEditionBenefit,
  type ContentEditionBuyerFactInput,
  type ContentEditionBuyerFactReader,
} from '../../src/access/authenticated-benefit.ts';
import { createAccess, type PermissionConfig, type PermissionContext } from '../../src/access/permission.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { createResourcePublicEligibility } from '../../src/access/eligibility.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { commandAccessContext } from '../../src/access/command-admission.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  type AuthoritativeTime,
} from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { AccountActor, Actor, Resource } from '../../src/request/access.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { setFixtureAccountState } from '../support/native-suspension-driver.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
// The trusted reader must release its checkout before Access continues. One
// connection detects accidental nesting in preparation or final authorization.
const pool = new Pool({ connectionString: url, max: 1 });
const buyer = newId(0x1234);
const principal = newId(0x2345);
const requestId = newId(0x2345);
const group = newId(0x3456);
const transactionId = newId(0x1234);
const target = { route: 0x4567, id: newId(0x4567) };
const benefit: ContentEditionBenefit = {
  kind: 'content-edition',
  resourceType: 'content.edition',
  resource: target,
  version: { revisionId: newId(0x4567), sha256: 'a'.repeat(64) },
  action: 'edition:read',
};
const resource: Resource = { ...target, authenticatedBenefit: benefit };
const action = benefit.action;
const actions = new Map([
  [action, { anonymous: false }],
  ['edition:sell', { anonymous: false }],
  ['edition:unpublish', { anonymous: false }],
  ['post:read', { anonymous: true }],
  ['access:grant', { anonymous: false }],
]);
const actor = (delegated = false): AccountActor => ({
  kind: 'account',
  accountId: buyer,
  clientId: 'native-benefit-test',
  scopes: [action],
  authnEpoch: 1,
  requestedBy: delegated ? `urn:rezics:request:${principal}:${requestId}` : null,
});
const config = (reader?: ContentEditionBuyerFactReader): PermissionConfig => ({
  actions,
  accountEvidence: (_actor, context) => context.account,
  ...(reader ? { contentEditionBuyerFactReader: reader } : {}),
});
const nativeReader: ContentEditionBuyerFactReader = async (input) => {
  // Commerce's current entitlement reader is an independent producer. This
  // fixture exercises the exact Access issuer/consumer boundary, not Commerce.
  await withConnection(pool, (client) => client.query('SELECT 1'));
  return createContentEditionBuyerFact({
    ...input,
    entitlementId: newId(routeOf(input.buyerAccountId)!),
    entitlementRevision: 1,
  });
};
async function atRead(run: (time: AuthoritativeTime) => Promise<void>) {
  const time = await withConnection(pool, (client) => mintReadTime(client));
  try {
    await run(time);
  } finally {
    releaseOperationalTime(time);
  }
}
async function context(who: Actor, time: AuthoritativeTime): Promise<PermissionContext> {
  return {
    pool,
    time,
    deadline: Date.now() + 5000,
    account: who.kind === 'account' ? await readAccount(pool, routeOf(who.accountId)!, who.accountId) : null,
  };
}
async function grant(subject: string, verb: string = action, on = target, role = '') {
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,$5,'(,)',$6)`,
    [on.route, on.id, subject, role, verb, transactionId],
  );
}
async function deny(subject: string, role = '') {
  await pool.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
     VALUES ($1,$2,$3,$4,$5,'resource','(,)',$6)`,
    [target.route, target.id, subject, role, action, transactionId],
  );
}
async function removeDenials() {
  await pool.query('DELETE FROM access.resource_denial');
}

beforeEach(async () => {
  await pool.query('TRUNCATE access.membership_inverse');
  await pool.query(`CREATE TABLE IF NOT EXISTS permission_public_fixture
    (route integer, id uuid, published boolean, valid tstzrange, PRIMARY KEY (route,id))`);
  await pool.query('DELETE FROM permission_public_fixture');
  await pool.query("INSERT INTO permission_public_fixture VALUES ($1,$2,true,'(,)')", [target.route, target.id]);
  for (const table of ['resource_grant', 'resource_denial', 'principal_assignment', 'organization_member', 'account'])
    await pool.query(`DELETE FROM access.${table}`);
  for (const id of [buyer, principal, group])
    await pool.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
       VALUES ($1,$2,$3,'active',$4)`,
      [routeOf(id), id, id === group ? 'organization' : 'actor', transactionId],
    );
  await pool.query(
    `INSERT INTO access.principal_assignment(route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$5)`,
    [routeOf(principal), principal, requestId, buyer, transactionId],
  );
});
afterAll(() => pool.end());

test('exact native authenticated edition entitlement augments only the matching buyer grant operand while scopes principal denials time deadline and current target authority remain mandatory', async () => {
  await atRead(async (time) => {
    const who = actor();
    const access = createAccess(config(nativeReader));
    const ctx = await context(who, time);
    const proof = await access.prepare!(who, action, resource, ctx);
    expect(await access.authorize(pool, who, action, resource, proof, time)).toBe(true);
    expect(await access.authorizeExplicit!(pool, who, action, resource, proof, time)).toEqual({
      allowed: true,
      explicit: false,
    });
    expect(await access.authorize(pool, who, action, resource, { ...(proof as object) }, time)).toBe(false);
    expect(await access.authorize(pool, who, 'post:read', resource, proof, time)).toBe(false);
    expect(await access.authorize(pool, who, action, { ...resource, id: newId(target.route) }, proof, time)).toBe(
      false,
    );
    const noScope = { ...who, scopes: [] };
    const denied = await access.prepare!(noScope, action, resource, await context(noScope, time));
    expect(await access.authorize(pool, noScope, action, resource, denied, time)).toBe(false);
    await deny(buyer);
    expect(await access.authorize(pool, who, action, resource, proof, time)).toBe(false);
    await removeDenials();
    expect(await access.authorize(pool, who, action, resource, proof, time)).toBe(true);
  });
});

test('the resolved different principal needs its own exact fact or ordinary grant and current assignment', async () => {
  await atRead(async (time) => {
    const who = actor(true);
    const calls: string[] = [];
    let running = false;
    const reader: ContentEditionBuyerFactReader = async (input) => {
      expect(running).toBe(false);
      running = true;
      calls.push(input.buyerAccountId);
      expect(input.time).toBe(time);
      expect(input.deadline).toBe(ctx.deadline);
      try {
        return input.buyerAccountId === buyer ? await nativeReader(input) : null;
      } finally {
        running = false;
      }
    };
    const access = createAccess(config(reader));
    const ctx = await context(who, time);
    const proof = await access.prepare!(who, action, resource, ctx);
    expect(calls).toEqual([buyer, principal]);
    expect(await access.authorize(pool, who, action, resource, proof, time)).toBe(false);
    await grant(principal);
    expect(await access.authorize(pool, who, action, resource, proof, time)).toBe(true);
    await deny(principal);
    expect(await access.authorize(pool, who, action, resource, proof, time)).toBe(false);
    await removeDenials();
    const both = createAccess(config(nativeReader));
    const bothProof = await both.prepare!(who, action, resource, ctx);
    await pool.query('DELETE FROM access.resource_grant');
    expect(await both.authorize(pool, who, action, resource, bothProof, time)).toBe(true);
    await pool.query('DELETE FROM access.principal_assignment');
    expect(await both.authorize(pool, who, action, resource, bothProof, time)).toBe(false);
  });
});

test('account standing, membership coverage and group bans remain mandatory', async () => {
  await atRead(async (time) => {
    let who = actor();
    const access = createAccess(config(nativeReader));
    async function allowed() {
      const proof = await access.prepare!(who, action, resource, await context(who, time));
      return access.authorize(pool, who, action, resource, proof, time);
    }
    expect(await allowed()).toBe(true);
    await setFixtureAccountState(pool, buyer, 'suspended');
    expect(await allowed()).toBe(false);
    await setFixtureAccountState(pool, buyer, 'active');
    // Reinstatement keeps the raised floor; the old token stays revoked.
    const restored = await readAccount(pool, routeOf(buyer)!, buyer);
    who = { ...who, authnEpoch: Number(restored!.minimumAuthnEpoch) };
    await pool.query('UPDATE access.account SET fenced=true WHERE route=$1 AND account_id=$2', [routeOf(buyer), buyer]);
    expect(await allowed()).toBe(false);
    await pool.query(
      'UPDATE access.account SET fenced=false, membership_inverse_complete=false WHERE route=$1 AND account_id=$2',
      [routeOf(buyer), buyer],
    );
    expect(await allowed()).toBe(false);
    await pool.query('UPDATE access.account SET membership_inverse_complete=true WHERE route=$1 AND account_id=$2', [
      routeOf(buyer),
      buyer,
    ]);
    await pool.query(
      `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
       VALUES ($1,$2,'organization',$3,$4,$4)`,
      [routeOf(buyer), buyer, group, transactionId],
    );
    await pool.query(
      `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
       VALUES ($1,$2,$3,'member','(,)',$4)`,
      [routeOf(group), group, buyer, transactionId],
    );
    await deny(group, 'member');
    expect(await allowed()).toBe(false);
    await removeDenials();
    expect(await allowed()).toBe(true);
  });
});

test('opaque copied bindings reject forged facts, invalid native keys/revisions, version time and deadline mismatch', async () => {
  await atRead(async (time) => {
    const input: ContentEditionBuyerFactInput = {
      benefit: structuredClone(benefit),
      buyerAccountId: buyer,
      entitlementId: newId(routeOf(buyer)!),
      entitlementRevision: 1,
      time,
      deadline: Date.now() + 5000,
    };
    const fact = createContentEditionBuyerFact(input);
    expect(Object.isFrozen(fact)).toBe(true);
    expect(matchesContentEditionBuyerFact(fact, input)).toBe(true);
    for (const forged of [{}, { ...fact }, structuredClone(fact), JSON.parse(JSON.stringify(fact))])
      expect(matchesContentEditionBuyerFact(forged, input)).toBe(false);
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
      expect(() => createContentEditionBuyerFact({ ...input, entitlementRevision: revision })).toThrow();
    for (const changes of [
      { buyerAccountId: 'not-a-native-key' },
      { entitlementId: newId(0x9876) },
      { benefit: { ...benefit, kind: 'other' } },
      { benefit: { ...benefit, resourceType: 'post' } },
      { benefit: { ...benefit, action: 'post:read' } },
      { benefit: { ...benefit, resource: { ...target, route: 0 } } },
      { benefit: { ...benefit, version: { ...benefit.version, revisionId: 'bad' } } },
      { benefit: { ...benefit, version: { ...benefit.version, sha256: 'A'.repeat(64) } } },
      { deadline: Infinity },
      { deadline: Date.now() - 1 },
      { time: {} },
    ])
      expect(() => createContentEditionBuyerFact({ ...input, ...changes } as ContentEditionBuyerFactInput)).toThrow();
    expect(matchesContentEditionBuyerFact(fact, { ...input, deadline: input.deadline + 1 })).toBe(false);
    expect(matchesContentEditionBuyerFact(fact, { ...input, buyerAccountId: principal })).toBe(false);
    expect(
      matchesContentEditionBuyerFact(fact, {
        ...input,
        benefit: { ...benefit, version: { ...benefit.version, revisionId: newId(target.route) } },
      }),
    ).toBe(false);
    const original = structuredClone(input.benefit);
    (input.benefit.version as { sha256: string }).sha256 = 'b'.repeat(64);
    expect(matchesContentEditionBuyerFact(fact, input)).toBe(false);
    expect(matchesContentEditionBuyerFact(fact, { ...input, benefit: original })).toBe(true);
    const later = await withConnection(pool, (client) => mintReadTime(client));
    try {
      expect(matchesContentEditionBuyerFact(fact, { ...input, benefit: original, time: later })).toBe(false);
    } finally {
      releaseOperationalTime(later);
    }
    const wallTime = Date.now;
    Date.now = () => input.deadline;
    try {
      expect(matchesContentEditionBuyerFact(fact, { ...input, benefit: original })).toBe(false);
    } finally {
      Date.now = wallTime;
    }
    releaseOperationalTime(time);
    expect(matchesContentEditionBuyerFact(fact, { ...input, benefit: original })).toBe(false);
  });
});

test('selector changes, later read objects, stale attempts and repurposed pages cannot reuse prepared authority', async () => {
  await atRead(async (time) => {
    const who = actor();
    const access = createAccess(config(nativeReader));
    const selected: Resource = { ...target, authenticatedBenefit: structuredClone(benefit) };
    const ctx = await context(who, time);
    const proof = await access.prepare!(who, action, selected, ctx);
    expect(await access.authorize(pool, who, action, selected, proof)).toBe(false);
    const later = await withConnection(pool, (client) => mintReadTime(client));
    try {
      expect(await access.authorize(pool, who, action, selected, proof, later)).toBe(false);
      const conflicting = commandAccessContext(
        { ...ctx, time: later },
        {
          time,
          partition: target.route >>> 4,
          basis: null,
        },
      );
      const rejected = await access.prepare!(who, action, selected, conflicting);
      expect(await access.authorize(pool, who, action, selected, rejected, time)).toBe(false);
    } finally {
      releaseOperationalTime(later);
    }
    (selected.authenticatedBenefit!.version as { sha256: string }).sha256 = 'b'.repeat(64);
    expect(await access.authorize(pool, who, action, selected, proof, time)).toBe(false);
    expect(
      await access.authorizePage!(
        pool,
        who,
        action,
        {
          route: target.route,
          resourceType: 'content.edition',
          ids: [target.id],
        },
        proof,
        time,
      ),
    ).toBe(false);
    expect(() =>
      access.preparePage!(
        who,
        action,
        {
          route: target.route,
          resourceType: 'content.edition',
          ids: [target.id],
          authenticatedBenefit: benefit,
        } as Resource & { resourceType: string; ids: string[] },
        ctx,
      ),
    ).toThrow();
    const wrong = await access.prepare!(who, 'post:read', resource, ctx);
    expect(await access.authorize(pool, who, 'post:read', resource, wrong, time)).toBe(false);
  });
});

test('null is proven absence; missing or unavailable readers are typed unavailability and deadlines never renew', async () => {
  await atRead(async (time) => {
    const who = actor();
    const ctx = await context(who, time);
    const absent = createAccess(config(async () => null));
    const proof = await absent.prepare!(who, action, resource, ctx);
    expect(await absent.authorize(pool, who, action, resource, proof, time)).toBe(false);
    await grant(buyer);
    expect(await absent.authorize(pool, who, action, resource, proof, time)).toBe(true);
    await expect(createAccess(config()).prepare!(who, action, resource, ctx)).rejects.toBeInstanceOf(
      AccessUnavailableError,
    );
    await expect(
      createAccess(
        config(async () => {
          throw new Error('source unavailable');
        }),
      ).prepare!(who, action, resource, ctx),
    ).rejects.toBeInstanceOf(AccessUnavailableError);
    const foreign = createAccess(
      config(async (input) =>
        createContentEditionBuyerFact({
          ...input,
          buyerAccountId: principal,
          entitlementId: newId(routeOf(principal)!),
          entitlementRevision: 1,
        }),
      ),
    );
    const invalid = await foreign.prepare!(who, action, resource, ctx);
    expect(await foreign.authorize(pool, who, action, resource, invalid, time)).toBe(false);
    const expired = { ...ctx, deadline: Date.now() - 1 };
    await expect(absent.prepare!(who, action, resource, expired)).rejects.toBeInstanceOf(AccessUnavailableError);
  });
});

test('current target and container authority independently deny disclosure after buyer permission was prepared', async () => {
  await atRead(async (time) => {
    const who = actor();
    const access = createAccess(config(nativeReader));
    // An owning-module guard is deliberately independent of the buyer operand.
    // The existing permission fixture represents the target owner's current
    // readiness. Content's real edition/container producer owns its full guards.
    async function targetReady() {
      const result = await pool.query(
        'SELECT published AND valid @> $3::timestamptz AS ready FROM permission_public_fixture WHERE route=$1 AND id=$2',
        [target.route, target.id, authoritativeTimeValue(time)],
      );
      return result.rows[0]?.ready === true;
    }
    expect(await targetReady()).toBe(true); // owner prerequisite before preparation
    const proof = await access.prepare!(who, action, resource, await context(who, time));
    expect(await access.authorize(pool, who, action, resource, proof, time)).toBe(true);
    await pool.query('DELETE FROM permission_public_fixture WHERE route=$1 AND id=$2', [target.route, target.id]);
    const disclose = (await targetReady()) && (await access.authorize(pool, who, action, resource, proof, time));
    expect(disclose).toBe(false); // also required before conditional/byte responses
  });
});

test('ordinary public floors and explicit or Global authority do not receive buyer evidence', async () => {
  await atRead(async (time) => {
    let calls = 0;
    const access = createAccess(
      config(async (input) => {
        calls++;
        return nativeReader(input);
      }),
    );
    const anonymous: Actor = { kind: 'anonymous' };
    const free: Resource = {
      ...target,
      eligibility: createResourcePublicEligibility({
        resource: target,
        action: 'post:read',
        prepare: async () => ({}),
        verify: async () => true,
      }),
    };
    const publicProof = await access.prepare!(anonymous, 'post:read', free, await context(anonymous, time));
    expect(await access.authorize(pool, anonymous, 'post:read', free, publicProof, time)).toBe(true);
    const who = actor();
    await grant(buyer);
    const ordinary = await access.prepare!(who, action, target, await context(who, time));
    expect(await access.authorizeExplicit!(pool, who, action, target, ordinary, time)).toEqual({
      allowed: true,
      explicit: true,
    });
    const global = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
    await grant(buyer, 'access:grant', global);
    const governor = { ...who, scopes: ['access:grant'] };
    const governance = await access.prepare!(governor, 'access:grant', target, await context(governor, time));
    expect(await access.authorize(pool, governor, 'access:grant', target, governance, time)).toBe(true);
    expect(calls).toBe(0);
  });
});

test('the public native factory threads the trusted reader and caller-owned read time into the same formula', async () => {
  await atRead(async (time) => {
    const ctx = { pool, time, deadline: Date.now() + 5000 };
    let calls = 0;
    const access = admittedAccess({
      actions,
      contentEditionBuyerFactReader: async (input) => {
        calls++;
        expect(input.time).toBe(time);
        expect(Object.isFrozen(input.benefit.resource)).toBe(true);
        expect(Object.isFrozen(input.benefit.version)).toBe(true);
        return nativeReader(input);
      },
    });
    const who = await authenticateAccount(access, ctx, actor());
    const proof = await access.prepare!(who, action, resource, ctx);
    expect(await access.authorize(pool, who, action, resource, proof, time)).toBe(true);
    expect(calls).toBe(1);
  });
});
