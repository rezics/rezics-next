import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  GrowthBoundError,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import { nativeFixture, scopes } from './native-account-bindings-fixture.ts';

let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  // Both services use the run's database, so the harness vacuum covers Auth
  // stages and provisioning receipts as well as the kernel relations.
  migrateAuth(db.url);
  const pair = await generateKeyPair('ES256', { extractable: true });
  f = await nativeFixture(db.pool, () => db.openPool(), {
    database: { url: db.url, close() {} },
    privateKey: { ...(await exportJWK(pair.privateKey)), kid: 'growth-native' },
  });
}, 600000);
afterAll(async () => {
  await f?.close();
  await db?.close();
});

// These completed, unrelated rows are only read past. They never supply the
// identity, approval, provisioning evidence or replay of a measured workflow.
const background: Population = {
  name: 'native-registration-background',
  hotPartition: 0,
  rows({ ordinal, route }) {
    const human = newId(route);
    const robot = newId(route);
    const reservation = newId(route);
    const approval = newId(route);
    const at = '2000-01-01T00:00:00Z';
    const expires = '2000-01-01T00:05:00Z';
    const accounts = [human, robot].map((id, index) => ({
      route,
      account_id: id,
      kind: 'actor',
      state: 'active',
      handle: `baseline_native_${ordinal}_${index}`,
      operator_account_id: index ? human : null,
      operator_reservation_id: index ? reservation : null,
      transaction_id: id,
    }));
    return {
      'access.account': accounts,
      'access.handle_claim': accounts.map(({ account_id, handle }) => ({
        route: createHash('sha256').update(handle).digest().readUInt16BE(0),
        normalized_handle: handle,
        account_id,
        state: 'active',
        transaction_id: account_id,
      })),
      'access.resource_grant': accounts.map(({ account_id }) => ({
        route,
        resource_id: account_id,
        subject_id: account_id,
        action: 'account:read',
        valid: '(,)',
        transaction_id: account_id,
      })),
      'access.workflow_approval': [
        {
          route,
          approval_id: approval,
          actor_id: human,
          client_id: 'ordinary-test-client',
          scopes: ['account:manage'],
          authn_epoch: 1,
          operation_key: approval,
          operation: { kind: 'automated', operatorAccountId: human },
          digest: '0'.repeat(64),
          created_at: at,
          expires_at: expires,
          jwt_expires_at: expires,
          transaction_id: approval,
        },
      ],
      'access.lifecycle_coordination': [
        {
          route,
          account_id: human,
          reservation_id: reservation,
          related_account_id: robot,
          purpose: 'operator',
          transaction_id: reservation,
        },
      ],
      'access.operator_relation_slot': [
        {
          route,
          subject_account_id: robot,
          reservation_id: reservation,
          operator_account_id: human,
          terminal: false,
          transaction_id: reservation,
        },
      ],
      'core.receipt': accounts.flatMap(({ account_id }) =>
        ['actor-pending', 'actor-activated', 'self-read-installed', 'handle-claimed'].map((kind) => ({
          partition_no: partitionOf(route),
          principal_kind: 'account',
          principal_id: '00000000-0000-8000-8000-000000000001',
          command_kind: `access.${kind}`,
          idempotency_key: `${route}:baseline-${account_id}-${kind}`,
          request_digest: Buffer.alloc(32),
          epoch: 1,
          position: 1,
          transaction_id: account_id,
          response: {},
        })),
      ),
      'public.user': accounts.map(({ account_id }) => ({
        id: account_id,
        name: '',
        email: `${account_id}@ordinary.test`,
        emailVerified: false,
      })),
      'public.account': accounts.map(({ account_id }) => ({
        id: account_id,
        accountId: account_id,
        providerId: 'credential',
        userId: account_id,
        password: null,
        updatedAt: at,
      })),
      // Include issuance history for the background owners: after the shared
      // vacuum these point reads must also be beyond the small-table crossover.
      'public.session': accounts.map(({ account_id }) => ({
        id: account_id,
        token: `baseline-${account_id}`,
        userId: account_id,
        clientId: 'ordinary-test-client',
        expiresAt: '2099-01-01T00:00:00Z',
        updatedAt: at,
        grantedScope: scopes.join(' '),
        authnEpoch: 1,
        authTime: 1,
        authMethods: 'pwd',
      })),
      'public.auth_consent': accounts.map(({ account_id }) => ({
        account_id,
        client_id: 'ordinary-test-client',
        scopes,
      })),
      'public.auth_workflow_request': [
        {
          workflow_id: `baseline-${robot}`,
          digest: Buffer.alloc(32),
          request: { kind: 'automated', registrationId: robot, operatorAccountId: human },
        },
      ],
      'auth_dbos.workflow_status': accounts.map(({ account_id }) => ({
        workflow_uuid: `baseline-${account_id}`,
        status: 'SUCCESS',
        name: 'baseline-registration',
      })),
      'auth_dbos.workflow_events': accounts.map(({ account_id }) => ({
        workflow_uuid: `baseline-${account_id}`,
        key: 'baseline',
        value: '{}',
      })),
      'auth_dbos.notifications': accounts.map(({ account_id }) => ({
        message_uuid: account_id,
        destination_uuid: `baseline-${account_id}`,
        topic: 'baseline',
        message: '{}',
      })),
      'auth_dbos.workflow_input': accounts.map(({ account_id }) => ({
        workflow_uuid: `baseline-${account_id}`,
        inputs: '[]',
      })),
      'auth_dbos.workflow_output': accounts.map(({ account_id }) => ({
        workflow_uuid: `baseline-${account_id}`,
        output: '{}',
      })),
      'auth_dbos.operation_outputs': accounts.map(({ account_id }) => ({
        workflow_uuid: `baseline-${account_id}`,
        function_id: 0,
        function_name: 'baseline-registration',
      })),
      'public.auth_registration_stage': accounts.map(({ account_id, handle }) => ({
        registration_id: account_id,
        request_key: `baseline-${account_id}`,
        handle,
        account_id,
        request_digest: Buffer.alloc(32),
        completed_at: at,
      })),
      'public.auth_provisioning_receipt': accounts.map(({ account_id }) => ({
        idempotency_key: `baseline-${account_id}`,
        account_id,
        digest: Buffer.alloc(32),
        registration_id: account_id,
        reservation_id: account_id,
        authn_epoch: 1,
        expires_at: expires,
        owner_id: account_id,
        credential_id: account_id,
        provisioning_kind: 'credentialless',
      })),
    };
  },
};

test('fixed native human and automated registrations and exact replay stay bounded as old receipts and stages grow', async () => {
  const human = await f.person('growth-native-operator');
  const report = await checkGrowth(db, {
    name: 'ordinary native registration with all Auth and kernel statements',
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    // Retain the original operation slack; the harness classifies independent
    // DBOS queue/schedule supervisor statements as background work.
    slack: { statements: { absolute: 6, relative: 0 }, rows: { absolute: 6, relative: 0 } },
    repetitions: 2,
    grow: async (database, scale, previous) => {
      // Keep all three scales beyond the small-table sequential-scan crossover.
      // seed() defers its vacuum to checkGrowth's database-wide vacuum.
      if (!previous) await seed(database, background, { from: 0, to: 512 });
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
    },
    operation: async (_database, _scale, repetition) => {
      const key = `measured-native-${repetition}`;
      const person = await f.person(key);
      expect((await f.person(key)).accountId).toBe(person.accountId);
      const robot = await f.automated(`${key}-bot`, human);
      expect((await f.automated(`${key}-bot`, human)).accountId).toBe(robot.accountId);
    },
  }).catch((error: unknown) => {
    if (error instanceof GrowthBoundError)
      console.error('Native registration growth costs', JSON.stringify(error.samples));
    throw error;
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['public.auth_registration_stage']).toBeDefined();
    expect(sample.cost.relations?.['core.receipt']).toBeDefined();
  }
}, 600000);
