import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { Value } from 'typebox/value';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool } from '../../src/database/pool.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { ACCESS_EVENTS } from '../../src/access/events.ts';

await import('reylo/register');
const { bootstrapGovernance } = await import('../../src/access/bootstrap-governance.ts');
const { createDelegationCommands, DelegationDeniedError } = await import('../../src/access/delegation-commands.ts');
const { nativeFixture } = await import('./native-account-bindings-fixture.ts');

const url = process.env.DATABASE_URL!;
const pool = createPool(url);
let f: Awaited<ReturnType<typeof nativeFixture>>;
let principal: Awaited<ReturnType<typeof f.person>>;
let recipient: Awaited<ReturnType<typeof f.person>>;
let checkedAt = '';
let transactionAt = '';
const key = () => Bun.randomUUIDv7();

beforeAll(async () => {
  migrateAuth(url);
  const pair = await generateKeyPair('ES256', { extractable: true });
  f = await nativeFixture(pool, undefined, {
    database: { url, container: '', close() {} },
    privateKey: { ...(await exportJWK(pair.privateKey)), kid: 'assignment-revocation' },
  });
  principal = await f.person('revocation_principal');
  recipient = await f.person('revocation_recipient');
  await bootstrapGovernance(pool, principal.accountId);
  // Observe the real evaluator's time without replacing authentication or authorization.
  const authorize = f.access.authorize.bind(f.access);
  f.access.authorize = async (client, actor, action, resource, evidence, time) => {
    expect(time).toBeDefined();
    checkedAt = authoritativeTimeValue(time!);
    transactionAt = (await client.query('SELECT transaction_timestamp()::text AS at')).rows[0].at;
    return authorize(client, actor, action, resource, evidence, time);
  };
}, 60_000);

afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});

async function context() {
  const boundary = { pool, deadline: Date.now() + 20_000 };
  return { ...boundary, actor: await f.access.authenticate(principal.bearer, boundary) };
}

async function snapshot(requestId: string) {
  const result = await pool.query(
    `SELECT row_to_json(p) AS value FROM access.principal_assignment p
     WHERE route = $1 AND principal_id = $2 AND request_id = $3`,
    [routeOf(principal.accountId), principal.accountId, requestId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0].value;
}

for (const injected of [true, false]) {
  for (const validity of ['unbounded', 'active', 'future'] as const) {
    test(`${injected ? 'injected clock' : 'database time'} revokes ${validity} assignment at T and preserves immutability`, async () => {
      const now = Date.now();
      const configured = new Date(now + 60_000);
      let clockReads = 0;
      const config = {
        pool,
        access: f.access,
        action: 'account:manage',
        ...(injected
          ? {
              clock: () => {
                clockReads++;
                return configured;
              },
            }
          : {}),
      };
      const commands = createDelegationCommands(config);
      const valid =
        validity === 'unbounded'
          ? '(,)'
          : `[${new Date(now + (validity === 'future' ? 86_400_000 : -86_400_000)).toISOString()},${new Date(now + 172_800_000).toISOString()})`;
      const requestId = newId(routeOf(principal.accountId)!);
      const input = {
        principalId: principal.accountId,
        assignedActorId: recipient.accountId,
        requestId,
        valid,
        key: key(),
      };
      const created = await commands.create(await context(), input);
      const before = await snapshot(requestId);
      // A valid range cannot be changed without a consistent, non-null revocation time.
      await expect(
        pool.query(
          `UPDATE access.principal_assignment SET valid = 'empty'::tstzrange
           WHERE route = $1 AND principal_id = $2 AND request_id = $3`,
          [routeOf(principal.accountId), principal.accountId, requestId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        pool.query(
          `UPDATE access.principal_assignment SET revoked_at = $4
           WHERE route = $1 AND principal_id = $2 AND request_id = $3`,
          [routeOf(principal.accountId), principal.accountId, requestId, new Date(now)],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot(requestId)).toEqual(before);

      clockReads = 0;
      const earliest = Date.now();
      const revoked = await commands.revoke(await context(), {
        principalId: principal.accountId,
        requestId,
        key: key(),
      });
      const at = checkedAt;
      expect(revoked.replayed).toBe(false);
      expect(revoked.value).toEqual(created.value);
      expect(clockReads).toBe(injected ? 1 : 0);
      if (injected) {
        expect(new Date(at).toISOString()).toBe(configured.toISOString());
        expect(new Date(transactionAt).getTime()).toBeLessThan(configured.getTime());
      } else {
        expect(Date.parse(at)).toBeGreaterThanOrEqual(earliest);
        expect(Date.parse(at)).toBeLessThanOrEqual(Date.now());
      }
      const bounds = await pool.query(
        `SELECT revoked_at = $4::timestamptz AS at_t,
                valid = issued_valid * tstzrange(NULL, $4::timestamptz, '[)') AS intersected,
                isempty(valid) AS empty, upper(valid) = $4::timestamptz AS ends_at_t,
                upper_inc(valid) AS includes_t
         FROM access.principal_assignment WHERE route = $1 AND principal_id = $2 AND request_id = $3`,
        [routeOf(principal.accountId), principal.accountId, requestId, at],
      );
      expect(bounds.rows).toEqual([
        {
          at_t: true,
          intersected: true,
          empty: validity === 'future',
          ends_at_t: validity === 'future' ? null : true,
          includes_t: false,
        },
      ]);
      const after = await snapshot(requestId);
      expect({ ...after, valid: before.valid, revoked_at: before.revoked_at }).toEqual(before);
      const events = await pool.query(
        `SELECT data FROM core.outbox WHERE partition_no = $1 AND position = $2 AND epoch = $3 AND type = 'com.rezics.access.assignment.revoke.v1'`,
        [revoked.partition, revoked.position.toString(), revoked.epoch],
      );
      expect(events.rows).toEqual([{ data: revoked.value }]);
      const schema = ACCESS_EVENTS()['com.rezics.access.assignment.revoke.v1'];
      expect(Value.Check(schema, events.rows[0].data)).toBe(true);
      expect(Value.Check(schema, { ...revoked.value, key: input.key })).toBe(false);

      await expect(
        commands.revoke(await context(), { principalId: principal.accountId, requestId, key: key() }),
      ).rejects.toBeInstanceOf(DelegationDeniedError);
      await expect(commands.create(await context(), { ...input, key: key() })).rejects.toMatchObject({ code: '23505' });
      for (const change of [
        'revoked_at = NULL',
        "revoked_at = revoked_at + interval '1 second'",
        "valid = '(,)'::tstzrange",
        `assigned_actor_id = '${principal.accountId}'`,
        'creator_principal_id = NULL',
        `request_id = '${key()}'`,
        `principal_id = '${recipient.accountId}'`,
        'route = (route + 1) % 65536',
        "issued_valid = '[2000-01-01,2001-01-01)'::tstzrange",
        `transaction_id = '${key()}'`,
      ]) {
        await expect(
          pool.query(
            `UPDATE access.principal_assignment SET ${change} WHERE route = $1 AND principal_id = $2 AND request_id = $3`,
            [routeOf(principal.accountId), principal.accountId, requestId],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      expect(await snapshot(requestId)).toEqual(after);
      expect(
        (
          await pool.query(
            `SELECT count(*)::integer AS count FROM core.outbox WHERE type = 'com.rezics.access.assignment.revoke.v1' AND data = $1::jsonb`,
            [JSON.stringify(revoked.value)],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    });
  }
}
