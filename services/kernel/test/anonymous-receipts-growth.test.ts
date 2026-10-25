import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ANONYMOUS_PRINCIPAL_ID,
  IdempotencyConflictError,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
} from '../src/command/command.ts';
import { newId } from '../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from './support/growth.ts';

const partition = 4094;
const route = partition << 4;
// Start above the planner's small-table sequential-scan crossover.
const rowsPerScale = 512;
const kind = 'test.anonymous-growth';
const identity = principalCommandIdentity({ kind: 'anonymous' });
const digest = new Uint8Array(32).fill(7);
const event = { type: 'com.rezics.test.anonymous_growth.v1', data: {} };
// This trusted authorization fixture isolates the executor's cost. Native Access
// and owning-domain callback costs are proved separately by their own suites.
const authorization: CommandAuthorization = {
  action: 'test:create',
  resource: { route, id: newId(route) },
  async authorize() {
    return 'execute';
  },
  denied: () => new Error('denied'),
};
const population: Population = {
  name: 'anonymous-receipt-history',
  hotPartition: partition,
  hotShare: 1,
  rows({ ordinal, route }) {
    const transaction = newId(route);
    const position = (ordinal + 1) * 1000;
    return {
      'core.receipt': [
        {
          partition_no: partition,
          principal_kind: 'anonymous',
          principal_id: ANONYMOUS_PRINCIPAL_ID,
          command_kind: kind,
          idempotency_key: `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`,
          request_digest: digest,
          epoch: 1,
          position,
          transaction_id: transaction,
          response: { accepted: true },
        },
      ],
      'core.outbox': [
        {
          partition_no: partition,
          position,
          event_seq: 0,
          event_count: 1,
          epoch: 1,
          id: newId(route),
          type: event.type,
          subject: null,
          data: event.data,
        },
      ],
      'editorial.write_basis': [
        {
          partition_no: partition,
          transaction_id: transaction,
          epoch: 1,
          position,
          principal_kind: 'anonymous',
          principal_id: ANONYMOUS_PRINCIPAL_ID,
          client_id: null,
          requested_by: null,
        },
      ],
    };
  },
  async finish(admin, range) {
    await admin.query('UPDATE core.partition SET position=GREATEST(position,$1::bigint) WHERE partition_no=$2', [
      range.to * 1000,
      partition,
    ]);
  },
};

test('anonymous execute, replay and conflict stay bounded with same-partition principal history at 1x/8x/64x', async () => {
  const db = await openGrowthDatabase();
  try {
    const report = await checkGrowth(db, {
      name: 'Anonymous receipt history',
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        await seed(database, population, { from: previous * rowsPerScale, to: scale * rowsPerScale });
      },
      async operation() {
        const options = { ...identity, partition, authorization, receipt: { kind, key: randomUUID(), digest } };
        const first = await runCommand(db.pool, options, async () => ({ value: { accepted: true }, events: [event] }));
        expect(first.replayed).toBe(false);
        const unexpected = async (): Promise<never> => {
          throw new Error('Replay ran an effect');
        };
        expect(await runCommand(db.pool, options, unexpected)).toEqual({ ...first, replayed: true });
        await expect(
          runCommand(
            db.pool,
            {
              ...options,
              receipt: { ...options.receipt, digest: new Uint8Array(32).fill(8) },
            },
            unexpected,
          ),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
    for (const { cost } of report.samples) {
      expect(cost.relations?.['core.receipt']?.rows).toBeGreaterThan(0);
      expect(cost.relations?.['core.receipt']?.sequentialScans).toBe(0);
    }
    console.log(JSON.stringify({ name: report.name, samples: report.samples }));
  } finally {
    await db.close();
  }
}, 90_000);
