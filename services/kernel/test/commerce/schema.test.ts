import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x1234;
const id = (n: number, r = route) =>
  `00000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;

async function rejected(c: PoolClient, sql: string, values: unknown[] = [], code = '23514') {
  await c.query('SAVEPOINT rejection');
  try {
    expect(
      await c.query(sql, values).then(
        () => null,
        (error: unknown) => error,
      ),
    ).toMatchObject({ code });
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT rejection');
  }
}

const offer = `INSERT INTO commerce.offer
  (route, offer_id, creator_account_id, target_subject_id, title, currency, unit_amount_minor, tax_code,
   royalty_basis_points, state, revision, created_at, updated_at, transaction_id)
  VALUES ($1, $2, $3, $4, 'Book', 'usd', 1200, 'txcd_10302000', 9000, 'active', 1, now(), now(), $4)`;
const order = `INSERT INTO commerce.purchase_order
  (route, order_id, buyer_account_id, offer_id, offer_revision, target_subject_id, creator_account_id, title, currency,
   unit_amount_minor, tax_code, royalty_basis_points, settlement, revision, created_at, updated_at, transaction_id)
  VALUES ($1, $2, $3, $4, 1, $4, $4, 'Book', 'usd', 1200, 'txcd_10302000', 9000, 'pending', 1, now(), now(), $4)`;
const entitlement = `INSERT INTO commerce.entitlement
  (route, entitlement_id, account_id, order_id, offer_id, target_subject_id, granted_at, revision, transaction_id)
  VALUES ($1, $2, $3, $4, $3, $3, now(), 1, $3)`;
const transaction = `INSERT INTO commerce.order_transaction
  (route, order_id, balance_transaction_id, kind, source_id, currency, amount_minor, fee_minor, net_minor,
   fee_details, stripe_created, recorded_at, transaction_id)
  VALUES ($1, $2, 'txn_valid', 'charge', 'ch_valid', 'usd', 1200, 100, 1100, '[]', now(), now(), $2)`;

test('commerce tables bind every key to its route and PostgreSQL enforces one entitlement per order and immutable order prices', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(offer, [route, id(1), id(2), id(3)]);
    await c.query(order, [route, id(4), id(2), id(1)]);
    await c.query(entitlement, [route, id(5), id(2), id(4)]);
    await c.query(transaction, [route, id(4)]);
    await rejected(c, offer, [route + 1, id(10), id(11), id(3)]);
    await rejected(c, offer, [route, id(10), id(11, route + 1), id(3)]);
    await rejected(c, order, [route + 1, id(10), id(11), id(1)]);
    await rejected(c, order, [route, id(10), id(11, route + 1), id(1)]);
    await rejected(c, entitlement, [route, id(6), id(2), id(4)], '23505');
    await rejected(c, entitlement, [route + 1, id(10), id(11), id(12)]);
    await rejected(c, entitlement, [route, id(10), id(11, route + 1), id(12)]);
    await rejected(c, entitlement, [route, id(10), id(11), id(12, route + 1)]);
    await rejected(c, transaction, [route + 1, id(10)]);
    for (const [table, key, value, assignments] of [
      [
        'offer',
        'offer_id',
        id(1),
        [
          "title = ''",
          "title = repeat('a', 201)",
          "currency = 'USD'",
          'unit_amount_minor = 0',
          'unit_amount_minor = 100000000',
          "tax_code = 'bad'",
          'royalty_basis_points = 10001',
          "state = 'unknown'",
          'revision = 0',
        ],
      ],
      [
        'purchase_order',
        'order_id',
        id(4),
        [
          "settlement = 'other'",
          'unit_amount_minor = 1300',
          `buyer_account_id = '${id(9)}'`,
          `offer_id = '${id(9)}'`,
          'offer_revision = 2',
          `creator_account_id = '${id(9)}'`,
          "title = 'New'",
          "currency = 'eur'",
          "tax_code = 'txcd_00000000'",
          'royalty_basis_points = 8000',
          "checkout_session_id = 'cs_test_partial'",
        ],
      ],
      [
        'entitlement',
        'entitlement_id',
        id(5),
        [
          "revoke_reason = 'refund'",
          'revoked_at = now()',
          `account_id = '${id(9)}'`,
          `order_id = '${id(9)}'`,
          `offer_id = '${id(9)}'`,
        ],
      ],
      [
        'order_transaction',
        'balance_transaction_id',
        'txn_valid',
        ["kind = 'other'", 'net_minor = 0', 'amount_minor = 1300'],
      ],
    ] as const) {
      for (const assignment of assignments) {
        await rejected(c, `UPDATE commerce.${table} SET ${assignment} WHERE route = $1 AND ${key} = $2`, [
          route,
          value,
        ]);
      }
    }
    await rejected(c, transaction.replace("'charge'", "'other'").replace('txn_valid', 'txn_invalid'), [route, id(4)]);
    await rejected(c, transaction.replace('1100', '1000').replace('txn_valid', 'txn_invalid'), [route, id(4)]);
    await c.query(
      `UPDATE commerce.purchase_order SET checkout_session_id = 'cs_test_valid', checkout_url = 'https://example.test', checkout_expires_at = now(), settlement = 'paid' WHERE route = $1 AND order_id = $2`,
      [route, id(4)],
    );
    for (const assignment of [
      "checkout_session_id = 'cs_test_other'",
      'checkout_session_id = NULL, checkout_url = NULL, checkout_expires_at = NULL',
      "checkout_url = 'https://other.test'",
      "checkout_expires_at = now() + interval '1 hour'",
      "settlement = 'pending'",
    ]) {
      await rejected(c, `UPDATE commerce.purchase_order SET ${assignment} WHERE route = $1 AND order_id = $2`, [
        route,
        id(4),
      ]);
    }
    await rejected(c, 'DELETE FROM commerce.order_transaction WHERE route = $1 AND balance_transaction_id = $2', [
      route,
      'txn_valid',
    ]);
    expect(
      (
        await c.query(
          `SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace = 'commerce'::regnamespace AND contype = 'f'`,
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
