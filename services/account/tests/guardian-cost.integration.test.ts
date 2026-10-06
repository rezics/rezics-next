import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { accountFixture } from './account-fixture.ts';
import { readGuardianInvitations } from '../src/recovery-guardian.ts';

interface Plan {
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: Plan[];
}
const tupleWork = (plan: Plan): number =>
  ((plan['Actual Rows'] ?? 0) + (plan['Rows Removed by Filter'] ?? 0)) *
    (plan['Actual Loops'] ?? 0) +
  (plan.Plans ?? []).reduce((sum, child) => sum + tupleWork(child), 0);

test('guardian costs: reading one live invitation does not scan expired mailbox history', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('cost-owner@example.test');
    const guardian = await f.signup('cost-guardian@example.test');
    expect(
      (
        await f.request(
          '/api/account/recovery-policy',
          {
            guardianEmail: guardian.email,
            currentPassword: owner.password,
            recoveryCode: randomBytes(32).toString('base64url'),
          },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    // Valid historical owners and expired invitations; no mail or credential
    // preparation is needed to test the read's lifetime-history cost boundary.
    await f.pool.query(
      `WITH owners AS (
      INSERT INTO public."user" SELECT (jsonb_populate_record(NULL::public."user",
        to_jsonb(u) || jsonb_build_object('id',gen_random_uuid()::text,
          'email','expired-' || n || '@example.test'))).* FROM public."user" u
        CROSS JOIN generate_series(1,20000) n WHERE u.id = $1 RETURNING id
    ), invitations AS (
      INSERT INTO rezics_account_recovery_guardian_invitation
        (id,owner_user_id,guardian_email,state,created_at,expires_at)
        SELECT gen_random_uuid(),id,$2,'pending',now() - interval '8 days',now() - interval '1 day'
        FROM owners RETURNING id,owner_user_id
    ) INSERT INTO rezics_account_recovery_policy (id,guardian_invitation_id,code_hash)
      SELECT owner_user_id,id,repeat('a',64) FROM invitations`,
      [owner.id, guardian.email],
    );
    await f.pool.query(
      'ANALYZE public."user"; ANALYZE rezics_account_recovery_policy; ANALYZE rezics_account_recovery_guardian_invitation',
    );
    const session = await f.auth.api.getSession({
      headers: new Headers({ cookie: guardian.cookie }),
    });
    let statement: { sql: string; values: unknown[] } | undefined;
    const observed = new Proxy(f.pool, {
      get(target, key) {
        if (key !== 'query') return Reflect.get(target, key);
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes('WITH pending AS'))
            statement = { sql: args[0], values: args[1] as unknown[] };
          return Reflect.apply(target.query, target, args);
        };
      },
    });
    const page = await readGuardianInvitations(
      observed,
      guardian.id,
      session!.session.id,
      undefined,
      1,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.ownerEmail).toBe(owner.email);
    expect(page.nextCursor).toBeNull();
    expect(statement).toBeDefined();
    const explain = await f.pool.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement!.sql}`,
      statement!.values,
    );
    // Count real tuple/filter work, rather than imposing a host-speed threshold.
    // A volatile clock in the index predicate would filter all 20,001 rows.
    expect(tupleWork(explain.rows[0]!['QUERY PLAN'][0]!.Plan)).toBeLessThan(1000);
  } finally {
    await f.close();
  }
}, 120_000);
