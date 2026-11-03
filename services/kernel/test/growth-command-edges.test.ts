import { expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
} from '../src/command/command.ts';
import { newId } from '../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from './support/growth.ts';

const partition = 3080;
const route = partition << 4;
const accountId = newId(route);
const digest = new Uint8Array(32).fill(7);
const event = { type: 'com.rezics.growth.event.v1', data: { value: 1 } };
const scenarios = ['revoked', 'receipt-only', 'conflict', 'body-failed', 'sql-aborted', 'finalizer-failed'] as const;

for (const principalKind of ['account', 'anonymous'] as const) {
  for (const [index, scenario] of scenarios.entries()) {
    if (principalKind === 'anonymous' && scenario === 'conflict') continue;

    test(`${principalKind} ${scenario} command stays bounded as receipt history grows`, async () => {
      const db = await openGrowthDatabase();
      const kind = `growth-command-edges-${principalKind}-${scenario}`;
      const identity = principalCommandIdentity(
        principalKind === 'anonymous'
          ? { kind: 'anonymous' }
          : { kind: 'account', accountId, clientId: kind, requestedBy: null, scopes: [], authnEpoch: 1 },
      );
      const positionBase = (index + (principalKind === 'anonymous' ? scenarios.length : 0)) * 100_000;
      const population: Population = {
        name: kind,
        hotPartition: partition,
        rows: ({ ordinal, route: rowRoute, partition: rowPartition }) => ({
          'core.receipt': [
            {
              partition_no: rowPartition,
              principal_kind: identity.principal.kind,
              principal_id: identity.principal.id,
              command_kind: kind,
              idempotency_key: `seed-${ordinal}`,
              request_digest: digest,
              epoch: 1,
              position: positionBase + ordinal + 1,
              transaction_id: newId(rowRoute),
              response: { accepted: true },
            },
          ],
        }),
      };
      const failure = new Error(scenario);
      const unexpected = async (): Promise<never> => {
        throw new Error('Replay or denial ran the body');
      };
      const options = { ...identity, partition, receipt: { kind, key: crypto.randomUUID(), digest } };
      const authorization: CommandAuthorization = {
        action: 'growth:command',
        resource: { route, id: newId(route) },
        authorize: async () => 'execute',
        denied: () => failure,
      };
      const mutate = (tx: CommandTransaction) =>
        tx.query('UPDATE core.partition SET epoch = epoch + 1 WHERE partition_no = $1', [partition]);
      try {
        // Replay controls use a real committed outcome, rather than a seeded matching receipt.
        const first = await runCommand(db.pool, { ...options, authorization }, async () => ({
          value: { accepted: true },
          events: [event],
        }));
        const report = await checkGrowth(db, {
          name: `${principalKind} ${scenario} command`,
          scales: [1, 8, 64],
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          grow: async (database, scale, previous) => {
            await seed(database, population, { from: previous * 512, to: scale * 512 });
          },
          operation: async (_database, _scale, repetition) => {
            let authorized = 0;
            const auth: CommandAuthorization = {
              ...authorization,
              async authorize() {
                authorized++;
                if (scenario === 'revoked') throw failure;
                return scenario === 'receipt-only' || scenario === 'conflict' ? 'receipt-only' : 'execute';
              },
              async finalize(tx) {
                if (scenario !== 'finalizer-failed') throw new Error('Replay or failed body ran finalize');
                await mutate(tx);
                throw failure;
              },
            };
            const replay = scenario === 'revoked' || scenario === 'receipt-only' || scenario === 'conflict';
            const attempt = runCommand<{ accepted: boolean } | { repetition: number }>(
              db.pool,
              {
                ...options,
                authorization: auth,
                receipt: {
                  ...options.receipt,
                  key: replay ? options.receipt.key : crypto.randomUUID(),
                  digest: scenario === 'conflict' ? new Uint8Array(32).fill(8) : digest,
                },
              },
              replay
                ? unexpected
                : async (tx) => {
                    await mutate(tx);
                    if (scenario === 'body-failed') throw failure;
                    if (scenario === 'sql-aborted') await tx.query('SELECT 1 / 0');
                    return { value: { repetition }, events: [event] };
                  },
            );
            if (scenario === 'receipt-only' && principalKind === 'account')
              expect(await attempt).toEqual({ ...first, replayed: true });
            else if (scenario === 'conflict') await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
            else if (scenario === 'sql-aborted') await expect(attempt).rejects.toMatchObject({ code: '22012' });
            else await expect(attempt).rejects.toBe(failure);
            expect(authorized).toBe(1);
          },
        });
        expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
        for (const { cost } of report.samples) {
          if (scenario === 'revoked' || (principalKind === 'anonymous' && scenario === 'receipt-only'))
            expect(cost.relations).not.toHaveProperty('core.receipt');
          else {
            expect(cost.relations['core.receipt']).toBeDefined();
            if (scenario === 'receipt-only' || scenario === 'conflict')
              expect(cost.relations['core.receipt']?.rows).toBeGreaterThan(0);
          }
          expect(cost.relations['core.receipt']?.sequentialScans ?? 0).toBe(0);
        }
        const state = await db.admin.query('SELECT epoch, position::text FROM core.partition WHERE partition_no = $1', [
          partition,
        ]);
        expect(state.rows).toEqual([{ epoch: first.epoch, position: String(first.position) }]);
        const receipts = await db.admin.query(
          'SELECT count(*)::int AS count FROM core.receipt WHERE command_kind = $1',
          [kind],
        );
        expect(receipts.rows).toEqual([{ count: 64 * 512 + 1 }]);
      } finally {
        await db.close();
      }
    }, 180_000);
  }
}

for (const principalKind of ['account', 'anonymous'] as const) {
  test(`${principalKind} SQL-aborted key accepts a fresh retry as receipt history grows`, async () => {
    const db = await openGrowthDatabase();
    const kind = `growth-command-sql-retry-${principalKind}`;
    const identity = principalCommandIdentity(
      principalKind === 'anonymous'
        ? { kind: 'anonymous' }
        : { kind: 'account', accountId, clientId: kind, requestedBy: null, scopes: [], authnEpoch: 1 },
    );
    const authorization: CommandAuthorization = {
      action: 'growth:command',
      resource: { route, id: newId(route) },
      authorize: async () => 'execute',
      denied: () => new Error('denied'),
    };
    const population: Population = {
      name: kind,
      hotPartition: partition,
      rows: ({ ordinal, route: rowRoute, partition: rowPartition }) => ({
        'core.receipt': [
          {
            partition_no: rowPartition,
            principal_kind: identity.principal.kind,
            principal_id: identity.principal.id,
            command_kind: kind,
            idempotency_key: `seed-${ordinal}`,
            request_digest: digest,
            epoch: 1,
            position: (principalKind === 'account' ? 2_000_000 : 3_000_000) + ordinal + 1,
            transaction_id: newId(rowRoute),
            response: { accepted: true },
          },
        ],
      }),
    };
    try {
      const initial = await db.admin.query('SELECT epoch, position::text FROM core.partition WHERE partition_no = $1', [
        partition,
      ]);
      const epoch = initial.rows[0].epoch;
      let position = BigInt(initial.rows[0].position);
      const report = await checkGrowth(db, {
        name: `${principalKind} SQL-aborted key retry`,
        scales: [1, 8, 64],
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: async (database, scale, previous) => {
          await seed(database, population, { from: previous * 512, to: scale * 512 });
        },
        operation: async () => {
          const options = {
            ...identity,
            partition,
            authorization,
            receipt: { kind, key: crypto.randomUUID(), digest },
          };
          await expect(
            runCommand(db.pool, options, async (tx) => {
              await tx.query('UPDATE core.partition SET epoch = epoch + 1 WHERE partition_no = $1', [partition]);
              await tx.query('SELECT 1 / 0');
              return { value: { accepted: false }, events: [event] };
            }),
          ).rejects.toMatchObject({ code: '22012' });
          const retry = await runCommand(db.pool, options, async () => ({
            value: { accepted: true },
            events: [event],
          }));
          expect(retry.replayed).toBe(false);
          expect(retry.value).toEqual({ accepted: true });
          expect(retry.epoch).toBe(epoch);
          expect(BigInt(retry.position)).toBe(++position);
          expect(
            await runCommand(db.pool, options, async () => {
              throw new Error('Retry replay ran the body');
            }),
          ).toEqual({ ...retry, replayed: true });
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        expect(cost.relations['core.receipt']?.rows).toBeGreaterThan(0);
        expect(cost.relations['core.receipt']?.sequentialScans ?? 0).toBe(0);
      }
    } finally {
      await db.close();
    }
  }, 180_000);
}
