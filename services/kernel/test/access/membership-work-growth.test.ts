import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { createMembershipWorkPorts, enqueueMembership, registerAccounts } from '../../src/access/membership-work.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { derivedId, newId, routeOf } from '../../src/route/route.ts';
import { authenticated } from './membership-work-fixture.ts';
import { capture, openGrowthDatabase } from '../support/growth-capture.ts';
import { costOf, type Cost } from '../support/growth-cost.ts';
import { assertGrowth, type GrowthSample } from '../support/growth-bound.ts';
import { seed, type Population } from '../support/growth-seed.ts';

test('real durable joins and leaves have fixed command/history work under one 1x/8x/64x common seed', async () => {
  const database = await openGrowthDatabase();
  database.pool.options.max = 1;
  const client = await createWorkClient(database.url);
  const owner = newId(0x5170);
  const member = newId(0x5180);
  const group = newId(0x7190);
  const routeKey = Buffer.alloc(32, 59);
  const key = () => randomUUID();
  const measurements: Record<string, Cost[]> = { reserve: [], publish: [], release: [] };
  let measuring = false;
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
            const ports = createMembershipWorkPorts(
              { ...context, pool: database.pool },
              { authorize: async () => authenticated(database.admin, owner) },
            );
            const wrapped = { ...ports };
            for (const phase of ['reserve', 'publish', 'release'] as const) {
              const original = ports[phase];
              Object.assign(wrapped, {
                [phase]: async (...args: unknown[]) => {
                  if (!measuring) return (original as Function)(...args);
                  const measured = await capture(database, () => (original as Function)(...args));
                  measurements[phase]!.push(costOf(measured.capture));
                  return measured.value;
                },
              });
            }
            registerAccounts(context, wrapped);
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
            actor_account_id: actor,
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
    const samples: Record<string, GrowthSample[]> = { reserve: [], join: [], leave: [], release: [] };
    let from = 0;
    for (const scale of [1024, 8192, 65536]) {
      await seed(database, population, { from, to: scale });
      from = scale;
      for (const values of Object.values(measurements)) values.length = 0;
      measuring = true;
      await change();
      measuring = false;
      const costs = {
        reserve: measurements.reserve![0]!,
        join: measurements.publish![0]!,
        leave: measurements.publish![1]!,
        release: measurements.release![0]!,
      };
      expect(measurements.reserve).toHaveLength(1);
      expect(measurements.publish).toHaveLength(2);
      expect(measurements.release).toHaveLength(1);
      for (const [phase, cost] of Object.entries(costs)) {
        expect(cost.plans).toBeGreaterThan(0);
        samples[phase]!.push({ scale, cost });
      }
    }
    for (const values of Object.values(samples))
      assertGrowth(values, { rows: 'constant', statements: 'constant', blocks: 'logarithmic' });
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(samples).map(([phase, values]) => [
            phase,
            values.map(({ scale, cost }) => ({
              scale,
              rows: cost.rows,
              blocks: cost.blocks,
              statements: cost.statements,
            })),
          ]),
        ),
      ),
    );
  } finally {
    await runtime?.shutdown();
    await client.close();
    await database.close();
  }
}, 180000);
