INSERT INTO commerce.order_transaction
(route, order_id, balance_transaction_id, kind, source_id, currency, amount_minor, fee_minor, net_minor,
 fee_details, exchange_rate, stripe_created, recorded_at, transaction_id)
SELECT :route, :order_id::uuid, t.id, t.kind, t.source_id, t.currency, t.amount_minor, t.fee_minor, t.net_minor,
 t.fee_details, t.exchange_rate, t.created, :time::timestamptz, :transaction_id::uuid
FROM jsonb_to_recordset(:transactions::jsonb) AS t(id text, kind text, source_id text, currency text,
 amount_minor bigint, fee_minor bigint, net_minor bigint, fee_details jsonb, exchange_rate numeric, created timestamptz)
ON CONFLICT (route, balance_transaction_id) DO NOTHING
RETURNING balance_transaction_id;
