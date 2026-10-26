import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { nativeFixture } from './native-account-bindings-fixture.ts';

let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await nativeFixture(db.pool, () => db.openPool());
  // Real registrations supply same-partition history. Unrelated background rows
  // are inserted afterwards; no measured Auth witness or DBOS outcome is seeded with SQL.
  for (let offset = 0; offset < 512; offset += 8) {
    await Promise.all(
      Array.from({ length: 8 }, (_, n) => {
        const key = `baseline_native_${offset + n}`;
        return f.host.workflows.register({
          key,
          handle: key,
          email: `${key}@ordinary.test`,
          password: 'baseline native credential',
        });
      }),
    );
  }
  // Populate independent operator anchors as well as their subject rows, so
  // planner statistics include unrelated holds at every measured scale.
  const operators = await Promise.all(Array.from({ length: 16 }, (_, n) => f.person(`baseline-native-operator-${n}`)));
  for (let offset = 0; offset < 512; offset += 8) {
    await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        f.automated(`baseline-native-bot-${offset + n}`, operators[(offset + n) % operators.length]!),
      ),
    );
  }
  // Sign-in reads auth_consent and auth_client by key, and session expiry reads
  // session by expiresAt. A few dozen rows stay in the sequential-scan range, so
  // unrelated clients, consents and unexpired sessions are present before the
  // first scale. Sessions belong to spare users, one each, so the capacity
  // trigger keeps every background row.
  await f.authPool.query(
    `INSERT INTO auth_client (client_id, first_party, scopes)
     SELECT 'growth-background-client-' || i, false, ARRAY['read']
     FROM generate_series(0, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO auth_consent (account_id, client_id, scopes)
     SELECT 'growth-background-' || i, 'growth-background-client-0', ARRAY['read']
     FROM generate_series(1, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     SELECT 'growth-background-user-' || i, '', 'growth-background-user-' || i || '@background.test', false
     FROM generate_series(1, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO session (id, token, "expiresAt", "updatedAt", "userId", "clientId", "grantedScope", "authnEpoch", "authTime", "authMethods")
     SELECT 'growth-background-session-' || i, 'growth-background-token-' || i, '2099-01-01'::timestamptz,
            statement_timestamp(), 'growth-background-user-' || i, 'growth-background-client-0', 'read', 1, 1, 'pwd'
     FROM generate_series(1, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO account (id, "accountId", "providerId", "userId", "updatedAt")
     SELECT 'growth-background-credential-' || i, 'growth-background-user-' || i, 'credential',
            'growth-background-user-' || i, statement_timestamp()
     FROM generate_series(1, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO verification (id, identifier, value, "expiresAt")
     SELECT 'growth-background-verification-' || i, 'growth-background-' || i, 'x', '2099-01-01'::timestamptz
     FROM generate_series(1, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO auth_registration_stage (registration_id, request_key, handle, account_id, request_digest, completed_at)
     SELECT 'growth-background-registration-' || i, 'growth-background-request-' || i, 'growthbg' || i,
            'growth-background-stage-' || i, decode(repeat('00', 32), 'hex'), statement_timestamp()
     FROM generate_series(1, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO auth_provisioning_receipt (idempotency_key, account_id, digest)
     SELECT 'growth-background-provision-' || i, 'growth-background-stage-' || i, decode(repeat('ab', 32), 'hex')
     FROM generate_series(1, 4000) i`,
  );
  for (const table of [
    'auth_client',
    'auth_consent',
    '"user"',
    'session',
    'account',
    'verification',
    'auth_registration_stage',
    'auth_provisioning_receipt',
  ])
    await f.authPool.query(`VACUUM (ANALYZE) ${table}`);
  // Registration and replay also read the kernel relations below. A few hundred
  // real rows stay inside the sequential-scan range, so unrelated rows come first.
  const routeOfId = '(get_byte(uuid_send(id), 10) * 256) + get_byte(uuid_send(id), 11)';
  await db.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
     SELECT ${routeOfId}, id, 'actor', 'active', id
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 4000)) s`,
  );
  await db.admin.query(
    `INSERT INTO access.lifecycle_coordination(route, account_id, reservation_id, related_account_id, purpose, transaction_id)
     SELECT ${routeOfId}, id, id, id, 'membership', id
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 4000)) s`,
  );
  await db.admin.query(
    `INSERT INTO access.operator_relation_slot(route, subject_account_id, reservation_id, operator_account_id, terminal, transaction_id)
     SELECT ${routeOfId}, id, id, gen_random_uuid(), false, id
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 4000)) s`,
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     SELECT ${routeOfId}, id, id, 'subject:read', '(,)', id
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 4000)) s`,
  );
  await db.admin.query(
    `INSERT INTO access.handle_claim(route, normalized_handle, account_id, state, transaction_id)
     SELECT (get_byte(digest, 0) * 256) + get_byte(digest, 1), handle, gen_random_uuid(), 'active', gen_random_uuid()
     FROM (
       SELECT 'growthbg' || i AS handle, sha256(convert_to('growthbg' || i, 'UTF8')) AS digest
       FROM generate_series(1, 4000) i
     ) s`,
  );
  await db.admin.query(
    `INSERT INTO access.workflow_approval(
       route, approval_id, actor_id, client_id, scopes, authn_epoch, operation_key, operation, digest,
       created_at, expires_at, jwt_expires_at, transaction_id)
     SELECT ${routeOfId}, id, id, 'growth-background', ARRAY['read'], 1, 'growth-background-' || n,
            '{"kind":"background"}'::jsonb, repeat('ab', 32),
            statement_timestamp(), statement_timestamp() + interval '4 minutes',
            statement_timestamp() + interval '1 hour', id
     FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 4000) n) s`,
  );
  await db.admin.query(
    `INSERT INTO core.receipt(
       partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest, epoch, position, transaction_id, response)
     SELECT 0, 'account', id, 'unrelated.command', id::text, decode(repeat('00', 32), 'hex'), 1, 5000000 + n, id, '{}'::jsonb
     FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 4000) n) s`,
  );
  await db.admin.query(
    `INSERT INTO core.outbox(partition_no, position, event_seq, event_count, epoch, id, type, data)
     SELECT 0, 5000000 + n, 0, 1, 1, id, 'com.rezics.subject.created.v1', jsonb_build_object('id', id)
     FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 4000) n) s`,
  );
  await db.admin.query(
    `INSERT INTO editorial.write_basis(partition_no, transaction_id, epoch, position, principal_id, client_id, principal_kind)
     SELECT 0, id, 1, 5000000 + n, id, 'growth-background', 'account'
     FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 4000) n) s`,
  );
  await db.admin.query(
    `INSERT INTO access.membership_inverse(route, account_id, kind, group_id, reservation_id, transaction_id)
     SELECT ${routeOfId}, id, 'organization', id, id, id
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 4000)) s`,
  );
  await db.admin.query(
    `INSERT INTO access.organization_member(route, organization_id, member_account_id, role, valid, transaction_id)
     SELECT ${routeOfId}, id, gen_random_uuid(), 'member', '(,)', id
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 4000)) s`,
  );
  await db.admin.query(
    `INSERT INTO access.resource_role_grant(route, resource_id, subject_id, grant_role, valid, transaction_id)
     SELECT ${routeOfId}, id, id, 'unrelated.reader', '(,)', id
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 4000)) s`,
  );
  await db.admin.query(
    `INSERT INTO access.resource_denial(route, resource_id, subject_id, action, reason, valid, transaction_id)
     SELECT ${routeOfId}, id, id, 'subject:read', 'resource', '(,)', id
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 4000)) s`,
  );
  for (const table of [
    'access.account',
    'access.lifecycle_coordination',
    'access.operator_relation_slot',
    'access.resource_grant',
    'access.handle_claim',
    'access.workflow_approval',
    'access.membership_inverse',
    'access.organization_member',
    'access.resource_role_grant',
    'access.resource_denial',
    'core.receipt',
    'core.outbox',
    'editorial.write_basis',
  ])
    await db.admin.query(`VACUUM (ANALYZE) ${table}`);
}, 600000);
afterAll(async () => {
  await f?.close();
  await db?.close();
});

test('fixed native human and automated registrations and exact replay stay bounded as old receipts and stages grow', async () => {
  const human = await f.person('growth-native-operator');
  const report = await checkGrowth(db, {
    name: 'ordinary native registration with all Auth and kernel statements',
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    // Capture includes the native DBOS queue/schedule supervisor. As in Auth's
    // schedule growth suite, one overlapping wake contributes at most six reads.
    slack: { statements: { absolute: 6, relative: 0 }, rows: { absolute: 6, relative: 0 } },
    repetitions: 2,
    grow: async (_database, scale, previous) => {
      for (let index = previous; index < scale; index++) {
        await f.host.workflows.register({
          key: `old-native-${index}`,
          handle: `old_native_${index}`,
          email: `old-native-${index}@ordinary.test`,
          password: 'ordinary old native credential',
        });
        // Grow this operator's actual creation approvals, native receipts and
        // related Auth stages as well as the unrelated human registrations.
        await f.automated(`old-native-bot-${index}`, human);
        await f.bindings.internalLifecycle.cancelHandleTransition({
          accountId: human.accountId,
          handle: `cancel_${index}`,
          expectedHandle: null,
          operationId: `old-${index}`,
          reservationId: human.accountId,
          key: `old-${index}`,
        });
      }
      for (const table of [
        'core.receipt',
        'core.outbox',
        'editorial.write_basis',
        'access.account',
        'access.workflow_approval',
        'access.lifecycle_coordination',
        'access.operator_relation_slot',
        'access.resource_grant',
        'access.handle_claim',
      ])
        await db.admin.query(`VACUUM (ANALYZE) ${table}`);
      for (const table of [
        'auth_registration_stage',
        'auth_provisioning_receipt',
        'auth_consent',
        'auth_client',
        '"user"',
        'account',
        'session',
        'verification',
      ])
        await f.authPool.query(`VACUUM (ANALYZE) ${table}`);
    },
    operation: async (_database, _scale, repetition) => {
      const key = `measured-native-${repetition}`;
      const person = await f.person(key);
      expect((await f.person(key)).accountId).toBe(person.accountId);
      const robot = await f.automated(`${key}-bot`, human);
      expect((await f.automated(`${key}-bot`, human)).accountId).toBe(robot.accountId);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['public.auth_registration_stage']).toBeDefined();
    expect(sample.cost.relations?.['core.receipt']).toBeDefined();
  }
}, 600000);
