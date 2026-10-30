WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route
), inserted AS (
  INSERT INTO commerce.royalty_line AS retained
    (route, balance_transaction_id, creator_account_id, order_id, offer_id, kind, currency, money_unit,
     gross_minor, tax_minor, fee_minor, dispute_fee_minor, net_receipts_minor, royalty_basis_points,
     period, statement_id, stripe_created, recorded_at)
  SELECT input.route, l.id, :creator, :order_id, :offer_id, l.kind, l.currency, l.money_unit,
         l.gross, l.tax, l.fee, l.dispute_fee, l.net, :basis_points,
         :period, l.statement_id, l.created, :at
  FROM input, jsonb_to_recordset(:lines::jsonb) AS l(id text, kind text, currency text, money_unit jsonb, gross bigint, tax bigint,
    fee bigint, dispute_fee bigint, net bigint, statement_id uuid, created timestamptz)
  -- The unique-key probe compares only named movements, including their captured attribution.
  -- Exact replay skips UPDATE. A differing tuple reaches the existing immutable-row guard,
  -- which raises before any UPDATE; the entire command aborts, including other inserted lines.
  -- Under SERIALIZABLE, concurrent conflicts retry the native command and re-read this evidence.
  ON CONFLICT (route, balance_transaction_id) DO UPDATE
    SET balance_transaction_id = EXCLUDED.balance_transaction_id
    WHERE (retained.creator_account_id, retained.order_id, retained.offer_id, retained.kind, retained.currency, retained.money_unit,
           retained.gross_minor, retained.tax_minor, retained.fee_minor, retained.dispute_fee_minor,
           retained.net_receipts_minor, retained.royalty_basis_points, retained.stripe_created)
      IS DISTINCT FROM
          (EXCLUDED.creator_account_id, EXCLUDED.order_id, EXCLUDED.offer_id, EXCLUDED.kind, EXCLUDED.currency, EXCLUDED.money_unit,
           EXCLUDED.gross_minor, EXCLUDED.tax_minor, EXCLUDED.fee_minor, EXCLUDED.dispute_fee_minor,
           EXCLUDED.net_receipts_minor, EXCLUDED.royalty_basis_points, EXCLUDED.stripe_created)
  RETURNING retained.*
), totals AS (
  SELECT route, statement_id, creator_account_id, period, currency, money_unit, sum(gross_minor) AS gross,
         sum(tax_minor) AS tax, sum(fee_minor) AS fee, sum(dispute_fee_minor) AS dispute_fee,
         sum(CASE WHEN kind IN ('refund', 'refund_reversal') THEN -gross_minor ELSE 0 END) AS refunds,
         sum(CASE WHEN kind IN ('dispute', 'dispute_reversal') THEN -gross_minor ELSE 0 END) AS chargebacks,
         sum(net_receipts_minor) AS net, sum(net_receipts_minor::numeric * royalty_basis_points) AS weighted
  FROM inserted GROUP BY route, statement_id, creator_account_id, period, currency, money_unit ORDER BY currency
), statements AS (
  INSERT INTO commerce.payout_statement AS s
    (route, statement_id, creator_account_id, period, currency, money_unit, gross_minor, tax_minor, fee_minor,
     dispute_fee_minor, refunds_minor, chargebacks_minor, net_receipts_minor, weighted_net_minor)
  SELECT input.route, statement_id, creator_account_id, period, currency, money_unit, gross, tax, fee, dispute_fee,
         refunds, chargebacks, net, weighted FROM input, totals
  ON CONFLICT (route, creator_account_id, period, currency) DO UPDATE SET
    money_unit = EXCLUDED.money_unit,
    gross_minor = s.gross_minor + EXCLUDED.gross_minor,
    tax_minor = s.tax_minor + EXCLUDED.tax_minor,
    fee_minor = s.fee_minor + EXCLUDED.fee_minor,
    dispute_fee_minor = s.dispute_fee_minor + EXCLUDED.dispute_fee_minor,
    refunds_minor = s.refunds_minor + EXCLUDED.refunds_minor,
    chargebacks_minor = s.chargebacks_minor + EXCLUDED.chargebacks_minor,
    net_receipts_minor = s.net_receipts_minor + EXCLUDED.net_receipts_minor,
    weighted_net_minor = s.weighted_net_minor + EXCLUDED.weighted_net_minor,
    revision = s.revision + 1
  RETURNING s.*
)
SELECT statement_id AS id, creator_account_id AS "creatorAccountId", period, currency, money_unit::text AS "moneyUnit",
       gross_minor::text AS "grossMinor", tax_minor::text AS "taxMinor", fee_minor::text AS "feeMinor",
       dispute_fee_minor::text AS "disputeFeeMinor", refunds_minor::text AS "refundsMinor",
       chargebacks_minor::text AS "chargebacksMinor", net_receipts_minor::text AS "netReceiptsMinor",
       weighted_net_minor::text AS "weightedNetMinor", state, paid_at::text AS "paidAt",
       paid_reference AS "paidReference", revision FROM statements;
