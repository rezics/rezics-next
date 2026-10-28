import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import {
  createPayouts,
  listPayoutLines,
  listPayoutStatements,
  readPayoutStatement,
} from '../../src/commerce/payouts.ts';
import { readPartition } from '../../src/partition/partition.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { derivedId, newId, partitionOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthCheck,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const ordinalsPerScale = 500;
const hotRoute = 0x3210;
const hotPartition = partitionOf(hotRoute);
const creator = newId(hotRoute);
const actor: AccountActor = {
  kind: 'account',
  accountId: creator,
  clientId: 'growth-payouts',
  scopes: ['payout_statement:list', 'payout_statement:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const anchorTransactionIds = Array.from({ length: 8 }, (_, index) => `txn_growth${String(index + 1).padStart(3, '0')}`);
// One warmup and five measured recordings per scale, each consuming eight fresh keys.
const recordingTransactionIds = Array.from({ length: 18 }, (_, run) =>
  Array.from({ length: 8 }, (_, index) => `txn_record${run}n${index}`),
);
let partitionEpoch = 1;
// Same binding and epoch the payout list seals: operation, account, and statement when paging lines.
function signedCursor(
  operation: 'payout_statement.list' | 'payout_statement.lines',
  after: string,
  statementId?: string,
) {
  return encodeCursor(
    tokens,
    {
      operation,
      parameters: statementId === undefined ? { accountId: creator } : { accountId: creator, statementId },
    },
    { epoch: partitionEpoch, after: [after] },
  );
}
const checkAccess = async (client: {
  query: (query: string, values?: unknown[]) => Promise<{ rowCount: number | null }>;
}) =>
  (
    await client.query(
      `SELECT 1 FROM access.resource_grant
     WHERE route = 0 AND resource_id = $1 AND subject_id = $2 AND action = $3 AND valid @> now() LIMIT 1`,
      [GLOBAL_CONTEXT, creator, 'payout_statement:list'],
    )
  ).rowCount === 1;
let anchorStatement = '';
const anchorOrder = newId(hotRoute);
const anchorOffer = newId(hotRoute);
let db: GrowthDatabase | undefined;
let populationNumber = 0;
let listSeededStatementIds: string[] = [];
function payoutLinesTag(): string {
  return `pg${anchorStatement.replaceAll('-', '').slice(-8)}`;
}
async function releaseSeedBulk(database: GrowthDatabase) {
  // Recorded transactions reject DELETE. Truncate the previous population and restore the anchor rows.
  const client = await database.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE keep_statement ON COMMIT DROP AS
       SELECT * FROM commerce.payout_statement WHERE route = $1 AND statement_id = $2`,
      [hotRoute, anchorStatement],
    );
    await client.query(
      `CREATE TEMP TABLE keep_grant ON COMMIT DROP AS
       SELECT * FROM access.resource_grant
       WHERE route = 0 AND resource_id = $1 AND subject_id = $2 AND action = 'payout_statement:list'`,
      [GLOBAL_CONTEXT, creator],
    );
    await client.query(
      `TRUNCATE commerce.royalty_line, commerce.order_transaction, commerce.purchase_order, commerce.payout_statement,
              access.resource_grant, core.outbox, core.receipt, editorial.write_basis`,
    );
    await client.query('INSERT INTO commerce.payout_statement SELECT * FROM keep_statement');
    await client.query('INSERT INTO access.resource_grant SELECT * FROM keep_grant');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
function population(name: string, includeLines: boolean): Population {
  const populationOffset = populationNumber++ * 32_000;
  const lineTag = name.startsWith('Payout lines page') ? payoutLinesTag() : `s${randomInt(36 ** 5).toString(36)}`;
  if (name.startsWith('Statement read and list')) listSeededStatementIds = [];
  const positionBase = Date.now() * 1_000 + randomInt(1_000_000_000) + populationNumber * 10_000;
  const currencyAndPeriod = (ordinal: number): { currency: string; period: string } => {
    const value = (populationOffset + ordinal) % 210_900;
    let code = value % 17_575;
    if (code >= 14_511) code++;
    const currency = `${String.fromCharCode(97 + Math.floor(code / 676))}${String.fromCharCode(97 + Math.floor((code % 676) / 26))}${String.fromCharCode(97 + (code % 26))}`;
    const month = 1 + Math.floor(value / 17_575);
    return { currency, period: `2025-${String(month).padStart(2, '0')}` };
  };
  return {
    name,
    hotPartition,
    hotShare: 1,
    // Each population mirrors commerce adapter writes and command-fence rows, including their route keys and JSON shapes.
    rows: ({ ordinal }) => {
      const route = hotRoute;
      const transactionId = newId(route);
      const rootTransactionId = newId(0);
      const statementId = derivedId(creator, `${name}:${populationOffset}:${ordinal}`, route);
      if (name.startsWith('Statement read and list')) listSeededStatementIds.push(statementId);
      const orderId = newId(route);
      const offerId = newId(route);
      const position = positionBase + ordinal * 100;
      const moneyKey = currencyAndPeriod(ordinal);
      const result: Record<string, readonly Record<string, unknown>[]> = {
        'commerce.payout_statement': [
          {
            route,
            statement_id: statementId,
            creator_account_id: creator,
            period: moneyKey.period,
            currency: moneyKey.currency,
            gross_minor: 100,
            tax_minor: 0,
            fee_minor: 0,
            dispute_fee_minor: 0,
            refunds_minor: 0,
            chargebacks_minor: 0,
            net_receipts_minor: 100,
            weighted_net_minor: 900000,
            state: 'open',
            paid_at: null,
            paid_reference: null,
            revision: 1,
          },
        ],
        'access.resource_grant': [
          {
            route: 0,
            resource_id: GLOBAL_CONTEXT,
            subject_kind: 'identity',
            subject_id: newId(0),
            subject_role: '',
            action: 'payout_statement:list',
            valid: '(,)',
            transaction_id: rootTransactionId,
          },
          {
            route,
            resource_id: newId(route),
            subject_kind: 'identity',
            subject_id: newId(route),
            subject_role: '',
            action: 'payout_statement:list',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'commerce.purchase_order': [
          {
            route,
            order_id: orderId,
            buyer_account_id: newId(route),
            offer_id: offerId,
            offer_revision: 1,
            target_subject_id: offerId,
            creator_account_id: creator,
            title: 'Growth book',
            currency: 'usd',
            unit_amount_minor: 1000,
            tax_code: 'txcd_10302000',
            royalty_basis_points: 9000,
            settlement: 'paid',
            created_at: '2025-12-01T00:00:00Z',
            updated_at: '2025-12-01T00:00:00Z',
            revision: 1,
            transaction_id: transactionId,
            amount_tax_minor: 0,
          },
        ],
        'commerce.order_transaction': [
          {
            route,
            order_id: orderId,
            balance_transaction_id: `txn_seed${lineTag}${String(ordinal).padStart(10, '0')}`,
            kind: 'charge',
            source_id: 'ch_seed',
            currency: 'usd',
            amount_minor: 1000,
            fee_minor: 0,
            net_minor: 1000,
            fee_details: [],
            exchange_rate: null,
            stripe_created: '2025-12-01T00:00:00Z',
            recorded_at: '2026-01-01T00:00:00Z',
            transaction_id: transactionId,
          },
        ],
        'core.outbox': [
          {
            partition_no: hotPartition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: newId(route),
            type: 'com.rezics.growth.payout-seed.v1',
            subject: 'seeded',
            data: { value: 1 },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: hotPartition,
            transaction_id: transactionId,
            epoch: 1,
            position,
            principal_id: creator,
            principal_kind: 'account',
            client_id: 'growth-payout-seed',
            requested_by: null,
          },
        ],
        'core.receipt': [
          {
            partition_no: hotPartition,
            principal_id: creator,
            principal_kind: 'account',
            command_kind: 'growth.payout.seed',
            idempotency_key: `payout-seed-${lineTag}-${ordinal}`,
            request_digest: Buffer.alloc(32, 1),
            epoch: 1,
            position,
            transaction_id: transactionId,
            response: { ok: true },
          },
        ],
      };
      if (includeLines)
        result['commerce.royalty_line'] = [
          {
            route,
            balance_transaction_id: `txn_${lineTag}${String(ordinal).padStart(10, '0')}`,
            creator_account_id: creator,
            order_id: orderId,
            offer_id: offerId,
            kind: 'charge',
            currency: 'usd',
            gross_minor: 100,
            tax_minor: 0,
            fee_minor: 0,
            dispute_fee_minor: 0,
            net_receipts_minor: 100,
            royalty_basis_points: 9000,
            period: '2025-12',
            statement_id: anchorStatement,
            stripe_created: '2025-12-01T00:00:00Z',
            recorded_at: '2026-01-01T00:00:00Z',
          },
        ];
      return result;
    },
    finish: async (admin, range) => {
      await admin.query(
        `UPDATE core.partition SET position = GREATEST(position, $2)
         WHERE partition_no = $1`,
        [hotPartition, positionBase + (range.to - 1) * 100],
      );
    },
  };
}

async function grow(
  database: GrowthDatabase,
  name: string,
  includeLines: boolean,
  operation: GrowthCheck['operation'],
) {
  const rows = population(name, includeLines);
  return checkGrowth(database, {
    name,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) =>
      seed({ pool: growthDb.pool, admin: growthDb.admin }, rows, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      }),
    operation,
  });
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  const database = db;
  await database.admin.query(
    `INSERT INTO core.partition(partition_no,node,position) VALUES ($1,'growth-payouts',0)
     ON CONFLICT (partition_no) DO NOTHING`,
    [hotPartition],
  );
  const partition = await readPartition(database.admin, hotPartition);
  if (!partition) throw new Error('Growth payout partition was not created');
  partitionEpoch = partition.epoch;
  // Fixed source history includes eight anchor lines and eight fresh keys for every growth recording.
  await database.admin.query(
    `INSERT INTO commerce.purchase_order
      (route,order_id,buyer_account_id,offer_id,offer_revision,target_subject_id,creator_account_id,title,currency,
       unit_amount_minor,tax_code,royalty_basis_points,settlement,created_at,updated_at,revision,transaction_id,amount_tax_minor)
     VALUES ($1,$2,$3,$4,1,$5,$6,'Growth book','usd',1000,'txcd_10302000',9000,'paid',
       '2025-12-01','2025-12-01',1,$7,0)`,
    [hotRoute, anchorOrder, newId(hotRoute), anchorOffer, newId(hotRoute), creator, newId(hotRoute)],
  );
  await database.admin.query(
    `INSERT INTO commerce.order_transaction
      (route,order_id,balance_transaction_id,kind,source_id,currency,amount_minor,fee_minor,net_minor,
       fee_details,stripe_created,recorded_at,transaction_id)
     SELECT $1,$2,id,'charge','ch_growth','usd',1000,0,1000,'[]'::jsonb,
       '2025-12-01','2026-01-01',$3 FROM unnest($4::text[]) AS id`,
    [hotRoute, anchorOrder, newId(hotRoute), [...anchorTransactionIds, ...recordingTransactionIds.flat()]],
  );
  const recorded = await createPayouts({
    pool: database.pool,
    clock: () => new Date('2026-01-20T12:00:00Z'),
  }).recordTransactions(anchorOrder, anchorTransactionIds, 'growth-payout-anchor-record');
  if ('changed' in recorded && !recorded.changed)
    throw new Error(`Production royalty anchor was not recorded: ${JSON.stringify(recorded)}`);
  const statement = await database.admin.query(
    `SELECT statement_id FROM commerce.payout_statement
     WHERE route = $1 AND creator_account_id = $2 AND period = '2026-01' AND currency = 'usd'`,
    [hotRoute, creator],
  );
  anchorStatement = statement.rows[0]?.statement_id as string;
  if (!anchorStatement) throw new Error('The production royalty command did not create its payout statement');
  await database.admin.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
     VALUES (0,$1,$2,'payout_statement:list','(,)'::tstzrange,$2)`,
    [GLOBAL_CONTEXT, creator],
  );
}, 90_000);

afterAll(async () => {
  if (!db) return;
  await db.close();
});

test('Royalty computation and payout record stays within its bound as q grows', async () => {
  // Source history is fixed at 152 keys; each recording reads eight. Unrelated seller statements grow q.
  const payouts = createPayouts({ pool: db!.pool, clock: () => new Date('2026-01-20T12:00:00Z') });
  const report = await grow(
    db!,
    'Royalty computation and payout record stays within its bound as q grows',
    true,
    async (_growthDb, _scale, repetition) => {
      const ids = recordingTransactionIds[repetition];
      if (!ids) throw new Error(`No fresh royalty keys for repetition ${repetition}`);
      const recorded = await payouts.recordTransactions(anchorOrder, ids, `royalty-growth-${repetition}`);
      expect('changed' in recorded).toBe(false);
    },
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 90_000);

test('Statement read and list stays within its bound as d grows', async () => {
  await releaseSeedBulk(db!);
  const report = await grow(
    db!,
    'Statement read and list stays within its bound as d grows',
    false,
    async (growthDb, scale) => {
      await readPayoutStatement(growthDb.pool, actor, anchorStatement, checkAccess);
      const cursorIndex = Math.min(listSeededStatementIds.length - 1, scale * ordinalsPerScale * 0.75);
      const after = listSeededStatementIds.slice().sort()[cursorIndex] ?? null;
      return listPayoutStatements(growthDb.pool, tokens, actor, checkAccess, {
        cursor: after === null ? null : signedCursor('payout_statement.list', after),
        limit: 20,
      });
    },
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 90_000);

test('Payout lines page stays within its bound as d grows', async () => {
  await releaseSeedBulk(db!);
  const report = await grow(
    db!,
    'Payout lines page stays within its bound as d grows',
    true,
    async (growthDb, scale) => {
      const after = `txn_${payoutLinesTag()}${String(Math.floor(scale * ordinalsPerScale * 0.75)).padStart(10, '0')}`;
      return listPayoutLines(growthDb.pool, tokens, actor, anchorStatement, checkAccess, {
        cursor: signedCursor('payout_statement.lines', after, anchorStatement),
        limit: 20,
      });
    },
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 90_000);

test('Mark paid stays within its bound as q grows', async () => {
  await releaseSeedBulk(db!);
  const targetIds: string[] = [];
  const recordPayout = createPayouts({ pool: db!.pool, clock: () => new Date('2026-02-20T12:00:00Z') });
  for (let index = 0; index < 18; index++) {
    const targetOrder = newId(hotRoute);
    const targetCurrency = `a${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
    const targetOffer = newId(hotRoute);
    const transactionId = newId(hotRoute);
    await db!.admin.query(
      `INSERT INTO commerce.purchase_order
       (route,order_id,buyer_account_id,offer_id,offer_revision,target_subject_id,creator_account_id,title,currency,
        unit_amount_minor,tax_code,royalty_basis_points,settlement,created_at,updated_at,revision,transaction_id,amount_tax_minor)
       VALUES ($1,$2,$3,$4,1,$5,$6,'Payout target','usd',100,'txcd_10302000',9000,'paid',
        '2025-12-01','2025-12-01',1,$7,0)`,
      [hotRoute, targetOrder, newId(hotRoute), targetOffer, newId(hotRoute), creator, transactionId],
    );
    const balanceTransactionId = `txn_paid${String(index).padStart(3, '0')}`;
    await db!.admin.query(
      `INSERT INTO commerce.order_transaction
       (route,order_id,balance_transaction_id,kind,source_id,currency,amount_minor,fee_minor,net_minor,
        fee_details,stripe_created,recorded_at,transaction_id)
       VALUES ($1,$2,$3,'charge','ch_paid',$4,100,0,100,'[]'::jsonb,'2025-12-01','2026-01-01',$5)`,
      [hotRoute, targetOrder, balanceTransactionId, targetCurrency, transactionId],
    );
    const recorded = await recordPayout.recordTransactions(targetOrder, [balanceTransactionId], `paid-target-${index}`);
    if ('changed' in recorded && !recorded.changed) throw new Error(`Failed to prepare paid target ${index}`);
    const targetId = derivedId(creator, `2026-02:${targetCurrency}`, hotRoute);
    const target = await db!.admin.query('SELECT 1 FROM commerce.payout_statement WHERE route=$1 AND statement_id=$2', [
      hotRoute,
      targetId,
    ]);
    if (target.rowCount !== 1) throw new Error(`Production royalty recording did not create paid target ${index}`);
    targetIds.push(targetId);
  }
  const report = await grow(
    db!,
    'Mark paid stays within its bound as q grows',
    false,
    async (growthDb, scale, repetition) => {
      const payouts = createPayouts({ pool: growthDb.pool, clock: () => new Date('2026-03-20T12:00:00Z') });
      const targetId = targetIds[repetition];
      if (!targetId) throw new Error(`No pre-created payout statement for repetition ${repetition}`);
      await payouts.markPaid(actor, targetId, 'bank-reference', `paid-growth-${scale}-${repetition}`, {
        action: 'payout_statement:mark_paid',
        resource: { route: 0, id: GLOBAL_CONTEXT },
        denied: () => new Error('access denied'),
        async prepare(attempt) {
          const result = await growthDb.pool.query(
            `SELECT 1 FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2
             AND action='payout_statement:list' AND valid @> now()`,
            [GLOBAL_CONTEXT, creator],
          );
          return result.rowCount === 1 ? attempt : null;
        },
        async authorize(_tx, _attempt, evidence) {
          return evidence ? 'execute' : 'receipt-only';
        },
      });
    },
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 90_000);
