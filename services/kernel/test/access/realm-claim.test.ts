import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { approveRealmClaim } from '../../src/access/index.ts';
import * as community from '../../src/community/index.ts';
import { compileViewerActionBindings } from '../../src/access/viewer-actions.ts';
import { newId } from '../../src/route/route.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import governance from '../../src/access/platform-governance.json';
import { NATIVE_CONTAINER_ACTIONS } from '../../src/community/actions.ts';
import { requestRealmClaim } from '../../src/community/realm-continuity.ts';
import { createRealm } from '../../src/community/realm.ts';
import { createSpace } from '../../src/community/space.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createNativeContentSystemWithWriteRateOverrides,
  type NativeContentSystem,
} from '../content/support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';

let system: NativeContentSystem;
let time: Date;
const day = 24 * 60 * 60 * 1000;
const context = (idempotencyKey = crypto.randomUUID()) => ({ deadline: Date.now() + 30_000, idempotencyKey });
const deps = () => ({
  pool: system.database.pool,
  access: system.access,
  routeKey: system.routeKey,
  clock: () => time,
});
const approver = () => system.actors.moderator.actor;
const claimant = () => system.actors.author.actor;
const competingClaimant = () => system.actors.other.actor;

async function clock(at: Date) {
  time = at;
  await system.clock.setCommandTime(at.toISOString());
}

/** Only native fixture state is seeded. Requests and approvals use their owning commands. */
async function orphan(early = false) {
  await clock(new Date());
  const space = await createSpace(deps(), competingClaimant(), { title: 'Claim host' }, context());
  const realm = await createRealm(
    deps(),
    competingClaimant(),
    { spaceId: space.value.spaceId, title: 'Claim community', visibility: 'public', contextId: GLOBAL_CONTEXT },
    context(),
  );
  const realmId = realm.value.realmId;
  const route = routeOf(realmId)!;
  const orphanedAt = time.toISOString();
  await system.database.pool.query(
    `UPDATE community.realm SET ownership_state='orphaned',orphaned_at=$3::timestamptz,
      claim_eligible_at=$3::timestamptz + interval '720 hours' WHERE route=$1 AND realm_id=$2`,
    [route, realmId, orphanedAt],
  );
  await system.database.pool.query(
    `DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
      AND subject_kind='identity' AND subject_role='' AND grant_role='community.realm.owner'`,
    [route, realmId],
  );
  await clock(new Date(time.getTime() + 30 * day));
  const request = await requestRealmClaim(deps(), claimant(), realmId, context());
  const competitor = await requestRealmClaim(deps(), competingClaimant(), realmId, context());
  // Existing bounded native upkeep makes current-role coverage explicit. No
  // empty page or fixture-owned owner registry is treated as absence of owners.
  await system.database.pool.query('SELECT access.advance_current_resource_roles($1)', [time.toISOString()]);
  await system.database.pool.query('SELECT access.advance_current_resource_roles($1)', [time.toISOString()]);
  if (early) await clock(new Date(time.getTime() - 1));
  return {
    realmId,
    requestId: request.value.requestId,
    competingRequestId: competitor.value.requestId,
    orphanedAt,
  };
}

async function snapshot(realmId: string) {
  const route = routeOf(realmId)!;
  const realm = await system.database.pool.query(
    `SELECT state,ownership_state,orphaned_at::text,claim_eligible_at::text,head_revision_id::text
      FROM community.realm WHERE route=$1 AND realm_id=$2`,
    [route, realmId],
  );
  const requests = await system.database.pool.query(
    `SELECT request_id::text,account_id::text,orphaned_at::text,requested_at::text,state
      FROM community.realm_claim_request WHERE route=$1 AND realm_id=$2 ORDER BY request_id`,
    [route, realmId],
  );
  const roles = await system.database.pool.query(
    `SELECT subject_id::text,subject_kind,subject_role,grant_role,valid::text,transaction_id::text
      FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
      ORDER BY subject_id,subject_role,grant_role,valid`,
    [route, realmId],
  );
  const receipts = await system.database.pool.query(
    `SELECT transaction_id::text,response FROM core.receipt WHERE partition_no=$1
      AND command_kind='access.realm.claim.approve' ORDER BY transaction_id`,
    [partitionOf(route)],
  );
  const events = await system.database.pool.query(
    'SELECT id::text,type,data FROM core.outbox WHERE partition_no=$1 AND subject=$2 ORDER BY id',
    [partitionOf(route), realmId],
  );
  return {
    realm: realm.rows,
    requests: requests.rows,
    roles: roles.rows,
    receipts: receipts.rows,
    events: events.rows,
  };
}

async function owners(realmId: string) {
  return (
    await system.database.pool.query<{ subject_id: string; starts: Date; infinite: boolean }>(
      `SELECT subject_id::text,lower(valid) AS starts,upper_inf(valid) AS infinite
      FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
        AND subject_kind='identity' AND subject_role='' AND grant_role='community.realm.owner'
        AND valid @> $3::timestamptz ORDER BY subject_id`,
      [routeOf(realmId), realmId, time.toISOString()],
    )
  ).rows;
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  await system.database.pool.query(
    `INSERT INTO access.resource_role_grant
      (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
      VALUES (0,$1,'identity',$2,'','platform.governance','(,)',$3)`,
    [PLATFORM_RESOURCE.id, approver().accountId, crypto.randomUUID()],
  );
});
afterAll(async () => system?.close());

test('only current exact platform approval at command T atomically grants the selected pending claimant native Realm ownership with the Content current orphan transition, and rejects stale generations or inactive claimants without effects', async () => {
  expect(NATIVE_CONTAINER_ACTIONS.get('realm:approve_claim')).toEqual({ anonymous: false });
  expect(governance.actions).toContain('realm:approve_claim');
  expect(governance.globalReach).not.toContain('realm:approve_claim');
  const pending = await orphan();
  const input = { realmId: pending.realmId, requestId: pending.requestId };
  const before = await snapshot(input.realmId);
  await seedGovernanceAuthority(system.database.pool, 0, PLATFORM_RESOURCE.id, claimant().accountId, [
    'access:grant',
    'realm:manage',
  ]);
  await expect(approveRealmClaim(deps(), claimant(), input, context())).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(approveRealmClaim(deps(), { kind: 'anonymous' }, input, context())).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  expect(await snapshot(input.realmId)).toEqual(before);

  // A direct action held on the Realm is not the fixed Global authority.
  await seedGovernanceAuthority(system.database.pool, routeOf(input.realmId)!, input.realmId, claimant().accountId, [
    'realm:approve_claim',
  ]);
  await expect(approveRealmClaim(deps(), claimant(), input, context())).rejects.toBeInstanceOf(GrantDeniedError);

  const key = crypto.randomUUID();
  const approvedAt = time.toISOString();
  const approved = await approveRealmClaim(deps(), approver(), input, context(key));
  expect(approved).toMatchObject({
    ...input,
    claimantAccountId: claimant().accountId,
    state: 'owned',
  });
  expect(Date.parse(approved.orphanedAt)).toBe(Date.parse(pending.orphanedAt));
  expect(Date.parse(approved.approvedAt)).toBe(Date.parse(approvedAt));
  expect(await owners(input.realmId)).toEqual([
    { subject_id: claimant().accountId, starts: new Date(approvedAt), infinite: true },
  ]);
  const after = await snapshot(input.realmId);
  expect(after.realm[0]).toMatchObject({ ownership_state: 'owned', orphaned_at: null, claim_eligible_at: null });
  await clock(new Date(time.getTime() + day));
  expect(await approveRealmClaim(deps(), approver(), input, context(key))).toEqual(approved);
  expect(await snapshot(input.realmId)).toEqual(after);
  await expect(
    approveRealmClaim(deps(), approver(), { realmId: input.realmId, requestId: pending.competingRequestId }, context()),
  ).rejects.toBeDefined();
  expect(await snapshot(input.realmId)).toEqual(after);

  const restricted = await system.auth.issue({
    accountId: approver().accountId,
    clientId: system.auth.ordinaryClient.id,
    scopes: ['realm:read'],
  });
  await expect(approveRealmClaim(deps(), restricted.actor, input, context(key))).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  expect(await snapshot(input.realmId)).toEqual(after);
  await system.database.pool.query(
    `DELETE FROM access.resource_role_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2
      AND subject_kind='identity' AND subject_role='' AND grant_role='platform.governance'`,
    [PLATFORM_RESOURCE.id, approver().accountId],
  );
  try {
    await expect(approveRealmClaim(deps(), approver(), input, context(key))).rejects.toBeInstanceOf(GrantDeniedError);
    expect(await snapshot(input.realmId)).toEqual(after);
  } finally {
    await system.database.pool.query(
      `INSERT INTO access.resource_role_grant
        (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
        VALUES (0,$1,'identity',$2,'','platform.governance','(,)',$3)`,
      [PLATFORM_RESOURCE.id, approver().accountId, crypto.randomUUID()],
    );
  }
});

test('early command T, stale orphan generation and inactive claimant leave grant, state, request and receipt unchanged', async () => {
  for (const refusal of ['early', 'stale', 'inactive'] as const) {
    const pending = await orphan(refusal === 'early');
    const route = routeOf(pending.realmId)!;
    if (refusal === 'stale') {
      await system.database.pool.query(
        `UPDATE community.realm SET ownership_state='owned',orphaned_at=NULL,claim_eligible_at=NULL
          WHERE route=$1 AND realm_id=$2`,
        [route, pending.realmId],
      );
      await system.database.pool.query(
        `UPDATE community.realm SET ownership_state='orphaned',orphaned_at=$3::timestamptz,
          claim_eligible_at=$3::timestamptz + interval '720 hours' WHERE route=$1 AND realm_id=$2`,
        [route, pending.realmId, new Date(time.getTime() - day).toISOString()],
      );
      await clock(new Date(time.getTime() + 30 * day));
    }
    if (refusal === 'inactive')
      await system.database.pool.query(
        "UPDATE access.account SET state='suspended',authn_fenced=true WHERE route=$1 AND account_id=$2",
        [routeOf(claimant().accountId), claimant().accountId],
      );
    const before = await snapshot(pending.realmId);
    try {
      await expect(
        approveRealmClaim(deps(), approver(), { realmId: pending.realmId, requestId: pending.requestId }, context()),
      ).rejects.toBeDefined();
      expect(await snapshot(pending.realmId)).toEqual(before);
    } finally {
      if (refusal === 'inactive')
        await system.database.pool.query(
          "UPDATE access.account SET state='active',authn_fenced=false WHERE route=$1 AND account_id=$2",
          [routeOf(claimant().accountId), claimant().accountId],
        );
    }
  }
});

test('competing requests serialize to one owner and same-request retry cannot create another grant or decision', async () => {
  const pending = await orphan();
  const input = { realmId: pending.realmId, requestId: pending.requestId };
  const key = crypto.randomUUID();
  const competingInput = { realmId: pending.realmId, requestId: pending.competingRequestId };
  const competingKey = crypto.randomUUID();
  const results = await Promise.allSettled([
    approveRealmClaim(deps(), approver(), input, context(key)),
    approveRealmClaim(deps(), approver(), competingInput, context(competingKey)),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(await owners(pending.realmId)).toHaveLength(1);
  const winner = results[0]!.status === 'fulfilled' ? 0 : 1;
  const result = results[winner]!;
  if (result.status !== 'fulfilled') throw new Error('Claim approval has no winner');
  const after = await snapshot(pending.realmId);
  expect(
    await approveRealmClaim(
      deps(),
      approver(),
      winner === 0 ? input : competingInput,
      context(winner === 0 ? key : competingKey),
    ),
  ).toEqual(result.value);
  expect(await snapshot(pending.realmId)).toEqual(after);
});

test('failed Content owned-state application rolls back the owner role, decision, request and receipt together', async () => {
  const pending = await orphan();
  await system.database.pool.query(`CREATE FUNCTION community.refuse_claim_fixture() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.realm_id = '${pending.realmId}'::uuid AND NEW.ownership_state='owned' THEN
        RAISE EXCEPTION 'claim application rollback fixture';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER refuse_claim_fixture BEFORE UPDATE ON community.realm
      FOR EACH ROW EXECUTE FUNCTION community.refuse_claim_fixture()`);
  const before = await snapshot(pending.realmId);
  try {
    await expect(
      approveRealmClaim(deps(), approver(), { realmId: pending.realmId, requestId: pending.requestId }, context()),
    ).rejects.toThrow('claim application rollback fixture');
    expect(await snapshot(pending.realmId)).toEqual(before);
  } finally {
    await system.database.pool.query('DROP TRIGGER refuse_claim_fixture ON community.realm');
    await system.database.pool.query('DROP FUNCTION community.refuse_claim_fixture()');
  }
});

test('installed approval advertises only fixed Global authority and maps missing source refusal before HTTP disclosure', async () => {
  const bindings = compileViewerActionBindings(system.kernel.routes);
  expect(bindings.get('semantic.context')?.find((entry) => entry.operationId === 'realm.approve_claim')).toMatchObject({
    action: 'realm:approve_claim',
    authority: 'resource',
    fixedResourceId: PLATFORM_RESOURCE.id,
  });
  expect(bindings.get('community.realm')?.some((entry) => entry.operationId === 'realm.approve_claim')).toBe(false);
  const pending = await orphan();
  const input = { realmId: pending.realmId, requestId: newId(routeOf(pending.realmId)!) };
  const before = await snapshot(input.realmId);
  await expect(approveRealmClaim(deps(), approver(), input, context())).rejects.toBeInstanceOf(GrantDeniedError);
  const response = await system.kernel.handle(
    new Request(`http://kernel.test/v1/realms/${input.realmId}/claimRequests/${input.requestId}:approve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${system.actors.moderator.bearer}`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
    }),
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'forbidden' });
  expect(await snapshot(input.realmId)).toEqual(before);
});

test('production Access receives original Community source custody, rolls back copied and prior-transaction sources, and HTTP replay retains the stored decision', async () => {
  const pending = await orphan();
  const input = { realmId: pending.realmId, requestId: pending.requestId };
  const before = await snapshot(input.realmId);
  const original = community.lockRealmClaimApprovalSource;
  let captured: community.LockedRealmClaimApproval | null = null;
  const copied = spyOn(community, 'lockRealmClaimApprovalSource').mockImplementation(async (tx, selection) => {
    captured = await original(tx, selection);
    return captured ? { ...captured } : null;
  });
  try {
    await expect(approveRealmClaim(deps(), approver(), input, context())).rejects.toBeDefined();
    expect(captured).not.toBeNull();
    expect(await snapshot(input.realmId)).toEqual(before);
  } finally {
    copied.mockRestore();
  }
  const previous = spyOn(community, 'lockRealmClaimApprovalSource').mockImplementation(async (tx, selection) => {
    await original(tx, selection);
    return captured;
  });
  try {
    await expect(approveRealmClaim(deps(), approver(), input, context())).rejects.toBeDefined();
    expect(await snapshot(input.realmId)).toEqual(before);
  } finally {
    previous.mockRestore();
  }
  const key = crypto.randomUUID();
  const send = () =>
    system.kernel.handle(
      new Request(`http://kernel.test/v1/realms/${input.realmId}/claimRequests/${input.requestId}:approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${system.actors.moderator.bearer}`, 'idempotency-key': JSON.stringify(key) },
      }),
    );
  const approved = await send();
  expect(approved.status).toBe(200);
  const receipt = await approved.json();
  expect(receipt).toMatchObject({ claim: { ...input, claimantAccountId: claimant().accountId, state: 'owned' } });
  const after = await snapshot(input.realmId);
  await clock(new Date(time.getTime() + day));
  const replay = await send();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect(await snapshot(input.realmId)).toEqual(after);
});

test('the mounted Global grant review receives installed gates, covers group delegation with gate:any, and reads back ordinary grant and revoke', async () => {
  await clock(new Date());
  // Explicit native client registration and consent receive the gate authority;
  // ordinary mounted-operation scopes alone do not carry gate:any.
  const scopes = [...system.auth.ordinaryScopes, 'gate:any'];
  await system.nativeAuth.internal.registerClient({
    clientId: system.auth.ordinaryClient.id,
    firstParty: true,
    scopes,
  });
  const operator = await system.auth.issue({
    accountId: approver().accountId,
    clientId: system.auth.ordinaryClient.id,
    scopes,
  });
  const group = system.kernel.routes
    .flatMap((route) => {
      const exposure = route.hooks?.detail?.['x-exposure'];
      return typeof exposure === 'string' && exposure.startsWith('gate:') ? [exposure.slice(5)] : [];
    })
    .sort()[0]!;
  expect(group).toBeDefined();
  const action = `gate:${group}`;
  const read = (bearer = operator.bearer) =>
    system.kernel.handle(
      new Request(`http://kernel.test/v1/grants?resourceId=${PLATFORM_RESOURCE.id}`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    );
  const response = await read();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const page = (await response.json()) as { actions: string[]; resource: { id: string; type: string } };
  expect(page.resource).toMatchObject({ id: PLATFORM_RESOURCE.id, type: 'semantic.context' });
  expect(page.actions).toContain('gate:any');
  expect(page.actions).toContain(action);
  const body = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: competingClaimant().accountId },
    actions: [action],
    valid: '(,)',
  };
  const write = (path: string) =>
    system.kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${operator.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify(body),
      }),
    );
  expect((await write('/v1/grants')).status).toBe(201);
  const granted = await read();
  expect(granted.status).toBe(200);
  const grants = (await granted.json()).grants as {
    subject: { id?: string };
    actions: string[];
    manageable: boolean;
  }[];
  expect(
    grants.find((row) => row.subject.id === competingClaimant().accountId && row.actions.includes(action)),
  ).toMatchObject({ manageable: true });
  expect((await read(system.actors.other.bearer)).status).toBe(404);
  expect((await write('/v1/grants:revoke')).status).toBe(200);
  const revoked = await read();
  expect(revoked.status).toBe(200);
  expect(
    (await revoked.json()).grants.some(
      (row: { subject: { id?: string }; actions: string[] }) =>
        row.subject.id === competingClaimant().accountId && row.actions.includes(action),
    ),
  ).toBe(false);
});
