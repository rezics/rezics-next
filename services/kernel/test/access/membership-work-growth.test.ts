import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { createMembershipWorkPorts, enqueueMembership, registerAccounts } from '../../src/access/membership-work.ts';
import { createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { derivedId, newId, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { authenticated } from './membership-work-fixture.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const PHASES = ['reserve', 'join', 'leave', 'release'] as const;
type Phase = (typeof PHASES)[number];

test('real durable joins and leaves keep reserve join leave and release command and history work within the same bounds through the shared growth harness at scales 256 1024 and 4096', async () => {
  const started = performance.now();
  // One instrumented pool per phase: a capture on a phase's database sees only that phase's command statements,
  // so the shared harness measures the four phases of the same durable workflow separately.
  const databases = {} as Record<Phase, GrowthDatabase>;
  try {
    for (const phase of PHASES) {
      databases[phase] = await openGrowthDatabase();
      databases[phase].pool.options.max = 1;
    }
  } catch (error) {
    await Promise.allSettled(Object.values(databases).map((opened) => opened.close()));
    throw error;
  }
  const database = databases.reserve;
  const client = await createWorkClient(database.url);
  const owner = newId(0x5170);
  const member = newId(0x5180);
  const group = newId(0x7190);
  const routeKey = Buffer.alloc(32, 59);
  const key = () => randomUUID();
  const calls: Record<Phase, number> = { reserve: 0, join: 0, leave: 0, release: 0 };
  let runtime: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    for (const id of [owner, member])
      await database.admin.query(
        "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)",
        [routeOf(id), id],
      );
    const native = createLifecycleInternals({
      pool: database.pool,
      routeKey,
      provisioningEvidence: async () => null,
      recoveryEvidence: async () => null,
    });
    const held = (
      await native.reserveCoordination({ accountId: owner, relatedAccountId: group, purpose: 'membership', key: key() })
    ).value;
    await native.createOrganization({
      organizationId: group,
      ownerAccountId: owner,
      ownerReservationId: held.reservationId,
      key: key(),
    });
    runtime = await composeWork(
      [
        {
          name: 'accounts',
          register(context) {
            const access = admittedAccess({ actions: new Map(LIFECYCLE_ACTIONS) });
            const ports = {} as Record<Phase, ReturnType<typeof createMembershipWorkPorts>>;
            for (const phase of PHASES)
              ports[phase] = createMembershipWorkPorts(
                { ...context, pool: databases[phase].pool },
                {
                  access,
                  authorize: async () => {
                    const request = await authenticated(database.admin, owner);
                    return {
                      ...request,
                      actor: await authenticateAccount(
                        access,
                        { pool: databases[phase].pool, deadline: Date.now() + 10_000 },
                        request.actor,
                      ),
                    };
                  },
                },
              );
            registerAccounts(context, {
              ...ports.reserve,
              async reserve(...args) {
                calls.reserve++;
                return ports.reserve.reserve(...args);
              },
              async publish(request, input, ...rest) {
                const phase = input.kind === 'membership' && input.role === null ? 'leave' : 'join';
                calls[phase]++;
                // Each phase command runs on its own pool, and admission binds the actor to that pool.
                const actor = await authenticateAccount(
                  access,
                  { pool: databases[phase].pool, deadline: Date.now() + 10_000 },
                  request.actor,
                );
                return ports[phase].publish({ ...request, actor }, input, ...rest);
              },
              async release(...args) {
                calls.release++;
                return ports.release.release(...args);
              },
            });
          },
        },
      ],
      {
        databaseUrl: database.url,
        pool: database.admin,
        client,
        env: { KERNEL_ROUTE_KEY: routeKey.toString('base64url') },
      },
    );
    await runtime.launch();
    async function change() {
      const input = {
        kind: 'membership' as const,
        principal: { kind: 'organization' as const, id: group },
        memberAccountId: member,
        role: 'member' as const,
        authorization: 'authenticated-fixture',
      };
      const joinId = `membership-growth:${key()}`;
      const joined = await (await enqueueMembership(client, joinId, input)).getResult();
      if (joined.status !== 'completed') throw new Error('Admission failed');
      const leaveId = `membership-growth:${key()}`;
      const leaveInput = { ...input, role: null, reservationId: joined.reservationId };
      await (await enqueueMembership(client, leaveId, leaveInput)).getResult();
      await (await enqueueMembership(client, joinId, input)).getResult();
      await (await enqueueMembership(client, leaveId, leaveInput)).getResult();
      // Replays retain the same two join steps and three leave steps.
      expect(
        (
          await database.admin.query('SELECT function_id FROM dbos.operation_outputs WHERE workflow_uuid=ANY($1)', [
            [joinId, leaveId],
          ])
        ).rows,
      ).toHaveLength(5);
      for (const phase of PHASES) {
        expect(calls[phase]).toBe(1);
        calls[phase] = 0;
      }
    }
    await change(); // Resolve catalog types and exercise every measured command first.
    const namespace = '658735df-3867-8020-8b4a-00a287891094';
    const population: Population = {
      name: 'durable-membership-history',
      hotPartition: routeOf(member)! >>> 4,
      rows({ ordinal, route }) {
        const actor = derivedId(namespace, `actor:${ordinal}`, route);
        const reservation = derivedId(namespace, `reservation:${ordinal}`, routeOf(member)!);
        const transaction = derivedId(namespace, `transaction:${ordinal}`, routeOf(group)!);
        const at = Date.UTC(2020, 0, 1) + ordinal * 60000;
        return {
          'access.account': [{ route, account_id: actor, kind: 'actor', state: 'active', transaction_id: transaction }],
          'access.membership_inverse': [
            {
              route,
              account_id: actor,
              kind: 'organization',
              group_id: group,
              reservation_id: derivedId(namespace, `inverse:${ordinal}`, route),
              transaction_id: transaction,
            },
          ],
          'access.lifecycle_coordination': [
            {
              route,
              account_id: actor,
              related_account_id: group,
              purpose: 'membership',
              reservation_id: derivedId(namespace, `inverse:${ordinal}`, route),
              transaction_id: transaction,
            },
          ],
          'core.receipt': [routeOf(member)! >>> 4, routeOf(group)! >>> 4].map((partition) => ({
            partition_no: partition,
            principal_kind: 'account',
            principal_id: actor,
            command_kind: 'access.membership-inverse-reserved',
            idempotency_key: `seed:${ordinal}`,
            request_digest: new Uint8Array(32),
            epoch: 1,
            position: ordinal + 1,
            transaction_id: transaction,
            response: {},
          })),
          'access.organization_member': [
            {
              route: routeOf(group),
              organization_id: group,
              member_account_id: member,
              role: 'member',
              valid: `[${new Date(at).toISOString()},${new Date(at + 30000).toISOString()})`,
              transaction_id: transaction,
            },
          ],
          'access.lifecycle_membership_slot': [
            {
              route: routeOf(group),
              organization_id: group,
              member_account_id: member,
              reservation_id: reservation,
              terminal: true,
              transaction_id: transaction,
            },
          ],
          'access.membership_inverse_terminal': [
            {
              route: routeOf(member),
              account_id: member,
              kind: 'organization',
              group_id: group,
              reservation_id: reservation,
              reservation_transaction_id: transaction,
              proof_transaction_id: transaction,
              transaction_id: transaction,
            },
          ],
        };
      },
    };
    let seeded = 0;
    const report: Record<string, { scale: number; rows: number; blocks: number; statements: number }[]> = {};
    for (const phase of PHASES) {
      const result = await checkGrowth(databases[phase], {
        name: `durable membership ${phase}`,
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(db, scale) {
          if (scale > seeded) await seed(db, population, { from: seeded, to: scale });
          seeded = Math.max(seeded, scale);
        },
        async operation() {
          await change();
        },
      });
      report[phase] = result.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        blocks: cost.blocks,
        statements: cost.statements,
      }));
    }
    console.log(JSON.stringify({ ...report, wallSeconds: Math.round((performance.now() - started) / 100) / 10 }));
  } finally {
    await runtime?.shutdown();
    await client.close();
    await Promise.all(PHASES.map((phase) => databases[phase].close()));
  }
}, 600000);
