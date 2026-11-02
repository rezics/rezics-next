import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { accountOperationTransport, type AccountOperationAccess } from '../src/account-operations-transport.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { newId, partitionOf, routeOf } from '../../kernel/src/route/route.ts';
import {
  capture,
  checkGrowth,
  GrowthBoundError,
  openGrowthDatabase,
  seed,
  type Population,
} from '../../kernel/test/support/growth.ts';

const clientId = 'transport-growth';
const scopes = ['organization:create'];
const at = '2000-01-01T00:00:00Z';
const expires = '2000-01-01T00:05:00Z';
const title = 'Account operation transport stays within its bound as account and approval history grows';
let openingOrdinal = 0;

/** Completed history never supplies authority or an outcome to a measured request. */
function history(actor: string): Population {
  const actorRoute = routeOf(actor)!;
  return {
    name: `account-transport-${actor}`,
    hotPartition: partitionOf(actorRoute),
    rows({ ordinal, route, hot }) {
      // Half the rows share the caller's exact route, half occupy other partitions.
      if (hot) route = actorRoute;
      const id = newId(route);
      const organization = newId(route);
      const approval = newId(hot ? actorRoute : route);
      const handle = `transport_history_${id.replaceAll('-', '')}`;
      const handleRoute = createHash('sha256').update(handle).digest().readUInt16BE(0);
      const transaction = { transaction_id: id };
      const resource = { route, resource_id: id, subject_id: id, valid: '(,)', ...transaction };
      const globalResource = {
        ...resource,
        route: 0,
        resource_id: '00000000-0000-8000-8000-000000000000',
      };
      const member = { route, organization_id: organization, member_account_id: id, ...transaction };
      const workflow = `transport-history-${id}`;
      const openingStart = Date.UTC(2000, 0, 1) + openingOrdinal++ * 2000;
      return {
        'access.account': [
          {
            route,
            account_id: id,
            kind: 'actor',
            state: 'active',
            handle: null,
            membership_inverse_complete: true,
            ...transaction,
          },
          {
            route,
            account_id: organization,
            kind: 'organization',
            state: 'active',
            handle,
            membership_inverse_complete: true,
            ...transaction,
          },
        ],
        'access.resource_grant': [
          { ...resource, action: 'account:read' },
          { ...globalResource, action: 'organization:create' },
        ],
        'access.resource_denial': [
          { ...resource, action: 'account:update', reason: 'resource' },
          { ...globalResource, action: 'organization:create', reason: 'resource' },
        ],
        'access.resource_role_grant': [
          { ...resource, grant_role: 'owner' },
          { ...globalResource, grant_role: 'owner' },
        ],
        'access.principal_assignment': [
          { route, principal_id: id, request_id: id, assigned_actor_id: id, valid: '(,)', ...transaction },
        ],
        'access.membership_inverse': [
          { route, account_id: id, kind: 'organization', group_id: organization, reservation_id: id, ...transaction },
        ],
        'access.membership_inverse_terminal': [
          {
            route,
            account_id: id,
            kind: 'organization',
            group_id: organization,
            reservation_id: organization,
            reservation_transaction_id: id,
            proof_transaction_id: id,
            ...transaction,
          },
        ],
        'access.organization_member': [{ ...member, role: 'owner', valid: '(,)' }],
        'access.lifecycle_membership_slot': [{ ...member, reservation_id: id }],
        'access.lifecycle_coordination': [
          {
            route,
            account_id: id,
            reservation_id: id,
            related_account_id: organization,
            purpose: 'membership',
            ...transaction,
          },
        ],
        'access.handle_claim': [
          {
            route: handleRoute,
            normalized_handle: handle,
            account_id: organization,
            state: 'active',
            reservation_id: id,
            ...transaction,
          },
        ],
        'access.lifecycle_handle_operation': [
          {
            route,
            account_id: organization,
            operation_id: workflow,
            handle,
            reservation_id: id,
            state: 'completed',
            ...transaction,
          },
        ],
        'access.lifecycle_handle_effect': [
          {
            route: handleRoute,
            normalized_handle: handle,
            account_id: organization,
            reservation_id: id,
            operation_id: workflow,
            effect: 'active',
            ...transaction,
          },
        ],
        'access.resource_initialization': [
          { route, resource_id: organization, resource_type: 'account', creator_id: id, initialized_at: at },
        ],
        'access.workflow_approval': [
          {
            route: hot ? actorRoute : route,
            approval_id: approval,
            actor_id: hot ? actor : id,
            client_id: clientId,
            scopes,
            authn_epoch: 1,
            operation_key: workflow,
            operation: { kind: 'organization', handle },
            digest: '0'.repeat(64),
            created_at: at,
            expires_at: expires,
            jwt_expires_at: expires,
            transaction_id: approval,
          },
        ],
        // All gate history is in the Global partition. Old organization openings
        // remain closed; unrelated group histories share that same index.
        'access.exposure_opening': [
          {
            route: 0,
            group: hot ? 'organizations' : `transport_${String.fromCharCode(97 + (ordinal % 8))}`,
            valid: `[${new Date(openingStart).toISOString()},${new Date(openingStart + 1000).toISOString()})`,
            ...transaction,
          },
        ],
        'semantic.context': [{ route, context_id: id, kind: 'community', labels: {} }],
        'core.receipt': [
          {
            partition_no: partitionOf(route),
            principal_kind: 'account',
            principal_id: hot ? actor : id,
            command_kind: 'access.workflow-approval.create',
            idempotency_key: workflow,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position: 1,
            ...transaction,
            response: {},
          },
        ],
        'public.user': [{ id, name: '', emailVerified: false }],
        'public.auth_client': [{ client_id: id, first_party: true, scopes }],
        'public.auth_client_coverage': [{ client_id: id, ready: true }],
        'public.auth_client_reduction': [{ client_id: id, operation_id: id, first_party: true, scopes }],
        'public.auth_consent': [{ account_id: id, client_id: clientId, scopes }],
        'public.session': [
          {
            id,
            token: `history-${id}`,
            userId: id,
            clientId,
            expiresAt: ordinal % 2 ? at : '2099-01-01T00:00:00Z',
            updatedAt: at,
            grantedScope: scopes.join(' '),
            authnEpoch: 1,
            authTime: 1,
            authMethods: 'pwd',
          },
        ],
        'public.auth_workflow_request': [
          { workflow_id: workflow, digest: Buffer.alloc(32), request: { kind: 'organization', handle } },
        ],
        'auth_dbos.workflow_status': [{ workflow_uuid: workflow, status: 'SUCCESS', name: 'accounts.operation' }],
        'auth_dbos.workflow_input': [{ workflow_uuid: workflow, inputs: '[]' }],
        'auth_dbos.workflow_output': [{ workflow_uuid: workflow, output: '{}' }],
        'auth_dbos.operation_outputs': [
          { workflow_uuid: workflow, function_id: 0, function_name: 'accounts.organization-key' },
        ],
        'auth_dbos.workflow_events': [{ workflow_uuid: workflow, key: 'completed', value: '{}' }],
        'auth_dbos.notifications': [
          { message_uuid: id, destination_uuid: workflow, topic: 'completed', message: '{}' },
        ],
      };
    },
  };
}

test(
  'Account operation transport stays within its bound as account and approval history grows',
  async () => {
    const database = testDatabase();
    const db = await openGrowthDatabase(database.url);
    let fixture:
      | Awaited<ReturnType<typeof import('../../kernel/test/access/native-account-bindings-fixture.ts').nativeFixture>>
      | undefined;
    let diagnostic: (() => Promise<void>) | undefined;
    try {
      migrateKernel(database.url);
      // Auth's check runner does not preload the Kernel SQL loader.
      await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
      const { nativeFixture, issuer, password } =
        await import('../../kernel/test/access/native-account-bindings-fixture.ts');
      const { admitGroup } = await import('../../kernel/src/access/gates/admission.ts');
      const { PLATFORM_RESOURCE } = await import('../../kernel/src/access/bootstrap-governance.ts');
      const key = {
        ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
        kid: 'transport-growth',
      };
      fixture = await nativeFixture(db.pool, () => db.openPool(), {
        database: { url: db.url, close() {} },
        privateKey: key,
      });
      const f = fixture;
      await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes });
      const approvals = f.approval();
      const context = () => ({ pool: db.pool, deadline: Date.now() + 10000 });
      const access: AccountOperationAccess = {
        context,
        approve: (token, input, ctx) => approvals.approve(token, input as never, ctx as never),
        resolveForCaller: (token, reference, operation, ctx) =>
          approvals.resolveForCaller(token, reference, operation as never, ctx as never),
        async admitGroup(token, group, ctx) {
          const bounded = ctx as ReturnType<typeof context>;
          const actor = await f.access.authenticate(token, bounded);
          await admitGroup({
            pool: db.pool,
            access: () => f.access,
            actor,
            group,
            clientAction: 'organization:create',
            deadline: bounded.deadline,
            clock: () => new Date(),
          });
          return true;
        },
      };
      const handler = accountOperationTransport(f.host.service, f.host.workflows, f.host.handler, access);
      type Candidate = {
        accountId: string;
        cookie: string;
        key: string;
        operation: { kind: 'organization'; handle: string };
      };
      let candidates: Candidate[] = [];
      async function operation() {
        const candidate = candidates.shift()!;
        async function send(command: string, body: unknown) {
          const response = await handler(
            new Request(`${issuer}/account-operations/${command}`, {
              method: 'POST',
              headers: { origin: issuer, 'content-type': 'application/json', cookie: candidate.cookie },
              body: JSON.stringify(body),
            }),
          );
          const result = await response.json();
          if (response.status !== 200) {
            // The public transport deliberately masks authentication errors.
            // Preserve the native failure when diagnosing a broken fixture.
            await f.host.service.internal.withFreshHuman(
              { headers: new Headers({ cookie: candidate.cookie }) },
              async (proof) => {
                const token = await f.host.service.internal.accessTokenForProof(proof);
                await access.admitGroup(token, 'organizations', context());
                await access.approve(
                  token,
                  {
                    operationKey: candidate.key,
                    operation: { ...candidate.operation, authorization: 'approval-request' },
                  },
                  context(),
                );
              },
            );
          }
          expect({ status: response.status, result }).toEqual({ status: 200, result: expect.anything() });
          expect(response.headers.get('cache-control')).toBe('no-store');
          return result as { reference: string; accountId: string };
        }
        const body = { operationKey: candidate.key, operation: candidate.operation };
        const approval = await send('approve', body);
        expect(approval.reference).toBeString();
        const result = await send('execute', { ...body, reference: approval.reference });
        expect(
          (
            await db.admin.query(
              `SELECT a.kind,a.state,a.handle,m.role FROM access.account a
         JOIN access.organization_member m ON m.route=a.route AND m.organization_id=a.account_id
         WHERE a.route=$1 AND a.account_id=$2 AND m.member_account_id=$3 AND m.valid @> statement_timestamp()`,
              [routeOf(result.accountId), result.accountId, candidate.accountId],
            )
          ).rows,
        ).toEqual([{ kind: 'organization', state: 'active', handle: candidate.operation.handle, role: 'owner' }]);
      }
      diagnostic = operation;
      // One organization, one fresh human session, one approval, and fixed native
      // workflow steps: rows/statements O(1), blocks O(log N). Each repetition has
      // a new actor, session, approval, handle and workflow key, with K=0 memberships
      // before dispatch and K=1 afterwards, independent of retained history.
      const report = await checkGrowth(db, {
        name: title,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        repetitions: 2,
        includeBackends: true,
        async grow(database, scale) {
          candidates = [];
          for (let index = 0; index < 4; index++) {
            const key = `transport-${scale}-${index}`;
            const person = await f.person(key);
            const signed = await f.request('/signin', {
              account_id: person.accountId,
              password,
              client_id: clientId,
              scope: scopes,
            });
            expect(signed.status).toBe(200);
            const cookie = signed.headers
              .getSetCookie()
              .map((value) => value.split(';')[0])
              .join('; ');
            // Privileged fixture grants exercise the closed gate and native formula;
            // no callback grants authority to the measured caller.
            await database.admin.query(
              `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
             SELECT $1,$2,$3,action,'(,)',$3 FROM unnest(ARRAY['gate:organizations','organization:create']) action`,
              [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, person.accountId],
            );
            // The two live native signins plus 62 expired sessions fill the
            // fixed 64-session owner cap. Growing same-owner rows would evict
            // the measured cookie rather than grow an admitted neighborhood.
            await database.admin.query(
              `INSERT INTO session (id,token,"userId","clientId","expiresAt","createdAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
               SELECT $1||'-old-'||i,$1||'-old-token-'||i,$1,$2,$3,$3,$3,$4,1,1,'pwd'
               FROM generate_series(1,62) i`,
              [person.accountId, clientId, at, scopes.join(' ')],
            );
            await seed(database, history(person.accountId), { from: 0, to: scale * 256 });
            candidates.push({
              accountId: person.accountId,
              cookie,
              key,
              operation: { kind: 'organization', handle: `transport_org_${scale}_${index}` },
            });
          }
        },
        operation,
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        for (const relation of [
          'public.session',
          'access.account',
          'access.workflow_approval',
          'access.exposure_opening',
          'public.auth_workflow_request',
          'auth_dbos.workflow_status',
        ])
          expect(cost.relations[relation]?.blocks).toBeGreaterThan(0);
      }
      console.info('Account operation transport growth:', JSON.stringify(report.samples));
    } catch (error) {
      if (error instanceof GrowthBoundError && diagnostic) {
        const measured = await capture(db, diagnostic, { includeBackends: true });
        console.info(
          'Account operation transport growth defect:',
          JSON.stringify({ samples: error.samples, capture: measured.capture }),
        );
      }
      throw error;
    } finally {
      await fixture?.close();
      await db.close();
      database.close();
    }
  },
  600000,
);
