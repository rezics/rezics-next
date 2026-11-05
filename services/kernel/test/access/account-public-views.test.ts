import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { readPublicAccountByHandle } from '../../src/access/account-data.ts';
import { readPublicViews } from '../../src/access/index.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { newId } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';

const pool = createPool(process.env.DATABASE_URL!);
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const commands = createLifecycleCommands({ pool, access });
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(41),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const owners = new Map<string, string>();
const defaults = { posts: true, reviews: true, collections: true };
const privateViews = { posts: false, reviews: false, collections: false };
const key = () => crypto.randomUUID();
afterAll(() => pool.end());
async function account(
  kind = 'actor',
  route = 0x4510,
  state = 'active',
  fenced = false,
): Promise<{ id: string; handle: string }> {
  const id = newId(route);
  const handle = `views_${key().replaceAll('-', '')}`;
  if (kind === 'organization' && state === 'active' && !fenced) {
    const owner = await account();
    const reservation = await internal.reserveCoordination({
      accountId: owner.id,
      relatedAccountId: id,
      purpose: 'membership',
      key: key(),
    });
    await internal.createOrganization({
      organizationId: id,
      ownerAccountId: owner.id,
      ownerReservationId: reservation.value.reservationId,
      key: key(),
    });
    await pool.query('UPDATE access.account SET handle=$3 WHERE route=$1 AND account_id=$2', [route, id, handle]);
    owners.set(id, owner.id);
  } else {
    await pool.query(
      'INSERT INTO access.account(route,account_id,kind,state,authn_fenced,handle,transaction_id) VALUES ($1,$2,$3,$4,$5,$6,$2)',
      [route, id, kind, state === 'suspended' ? 'active' : state, fenced, handle],
    );
    await pool.query(
      "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$2,'account:update','(,)',$2)",
      [route, id],
    );
  }
  await pool.query(
    "INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id) VALUES ($1,$2,$3,'active',$3)",
    [createHash('sha256').update(handle).digest().readUInt16BE(0), handle, id],
  );
  if (state === 'suspended') await suspendAccount(pool, id);
  return { id, handle };
}
async function patch(id: string, value: unknown, actorId = owners.get(id) ?? id) {
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10000 },
    { accountId: actorId, clientId: 'views', scopes: [...LIFECYCLE_ACTIONS.keys()] },
  );
  return commands.updateAccount({ actor, deadline: Date.now() + 10000 }, { accountId: id, key: key(), patch: value });
}

test('actors and organizations default to all public views and can independently turn each off and on', async () => {
  for (const kind of ['actor', 'organization']) {
    const { id, handle } = await account(kind);
    expect((await readPublicViews(pool, [id])).get(id)).toEqual(defaults);
    expect((await readPublicAccountByHandle(pool, handle))[0]).toMatchObject({ publicViews: defaults });
    const flags = { ...defaults };
    for (const view of ['posts', 'reviews', 'collections'] as const) {
      flags[view] = false;
      await patch(id, { publicViews: { [view]: false } });
      expect((await readPublicViews(pool, [id])).get(id)).toEqual(flags);
      expect((await readPublicAccountByHandle(pool, handle))[0]).toMatchObject({ publicViews: flags });
    }
    for (const view of ['posts', 'reviews', 'collections'] as const) {
      flags[view] = true;
      await patch(id, { publicViews: { [view]: true } });
      expect((await readPublicViews(pool, [id])).get(id)).toEqual(flags);
    }
    await patch(id, { publicViews: {} });
    expect((await readPublicViews(pool, [id])).get(id)).toEqual(defaults);
  }
});

test('only organizations expose and choose speakersListed, which defaults to false', async () => {
  const organization = await account('organization');
  expect((await readPublicAccountByHandle(pool, organization.handle))[0]).toHaveProperty('speakersListed', false);
  for (const speakersListed of [true, false]) {
    await patch(organization.id, { speakersListed });
    expect((await readPublicAccountByHandle(pool, organization.handle))[0]).toHaveProperty(
      'speakersListed',
      speakersListed,
    );
  }
  const actor = await account();
  expect((await readPublicAccountByHandle(pool, actor.handle))[0]).not.toHaveProperty('speakersListed');
  await expect(patch(actor.id, { speakersListed: true })).rejects.toThrow();
  await expect(patch(organization.id, { speakersListed: true }, actor.id)).rejects.toThrow();
});

test('invalid view patches and other accounts cannot change presentation fields', async () => {
  const { id } = await account();
  const other = await account();
  for (const publicViews of [null, [], false, { posts: 1 }, { posts: null }, { unknown: true }])
    await expect(patch(id, { publicViews, displayName: 'Wrong' })).rejects.toThrow();
  await expect(patch(id, { publicViews: privateViews }, other.id)).rejects.toThrow();
  expect((await readPublicViews(pool, [id])).get(id)).toEqual(defaults);
});

test('view batches default unknown, malformed, fenced and non-active accounts to all private', async () => {
  const active = await account('actor', 0x4511);
  const organization = await account('organization', 0x4521);
  const unavailable = [newId(0x4510), 'invalid'];
  for (const state of ['pending', 'suspended', 'deleted']) unavailable.push((await account('actor', 0x4530, state)).id);
  const fenced = await account('organization', 0x4540, 'active', true);
  unavailable.push(fenced.id);
  const result = await readPublicViews(pool, [active.id, organization.id, ...unavailable, active.id]);
  expect(result.size).toBe(2 + unavailable.length);
  expect(result.get(active.id)).toEqual(defaults);
  expect(result.get(organization.id)).toEqual(defaults);
  for (const id of unavailable) expect(result.get(id)).toEqual(privateViews);
  expect((await readPublicAccountByHandle(pool, fenced.handle))[0]).toMatchObject({
    publicViews: privateViews,
    speakersListed: false,
  });
  expect(await readPublicViews(pool, [])).toEqual(new Map());
  const hundred = Array.from({ length: 100 }, () => newId(0x4510));
  expect((await readPublicViews(pool, hundred)).size).toBe(100);
  await expect(readPublicViews(pool, [...hundred, active.id])).rejects.toBeInstanceOf(RangeError);
});
