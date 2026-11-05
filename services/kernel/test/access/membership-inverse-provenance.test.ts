import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createMembershipInverseCommands } from '../../src/access/membership-inverse.ts';
import { createLifecycleInternals, LifecycleDeniedError } from '../../src/access/lifecycle.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
afterAll(() => pool.end());
const key = () => Bun.randomUUIDv7();
const inverse = createMembershipInverseCommands({ pool });
const lifecycle = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(41),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});

async function inconsistentReservation() {
  const accountId = newId(0x5201);
  const groupId = newId(0x7301);
  const reservationId = newId(routeOf(accountId)!);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES($1,$2,'actor','active',$3)`,
    [routeOf(accountId), accountId, key()],
  );
  // Historical fixture corruption: identity matches, operation provenance does not.
  await pool.query(
    `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
     VALUES($1,$2,'organization',$3,$4,$5)`,
    [routeOf(accountId), accountId, groupId, reservationId, key()],
  );
  await pool.query(
    `INSERT INTO access.lifecycle_coordination(route,account_id,related_account_id,reservation_id,purpose,transaction_id)
     VALUES($1,$2,$3,$4,'membership',$5)`,
    [routeOf(accountId), accountId, groupId, reservationId, key()],
  );
  return { accountId, principal: { kind: 'organization' as const, id: groupId }, reservationId };
}

test('duplicate admission rejects a hold with mismatched operation provenance without spending a slot', async () => {
  const reservation = await inconsistentReservation();
  await expect(inverse.reserve({ ...reservation, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  const rows = await pool.query(
    'SELECT reservation_id FROM access.membership_inverse WHERE route=$1 AND account_id=$2',
    [routeOf(reservation.accountId), reservation.accountId],
  );
  expect(rows.rows).toEqual([{ reservation_id: reservation.reservationId }]);
});

test('first owner publication rejects matching reservation identity from a different operation', async () => {
  const reservation = await inconsistentReservation();
  await expect(
    lifecycle.createOrganization({
      organizationId: reservation.principal.id,
      ownerAccountId: reservation.accountId,
      ownerReservationId: reservation.reservationId,
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  const rows = await pool.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2', [
    routeOf(reservation.principal.id),
    reservation.principal.id,
  ]);
  expect(rows.rows).toEqual([]);
});
