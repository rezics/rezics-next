SELECT balance_transaction_id AS id, order_id AS "orderId", kind, source_id AS "sourceId", currency,
amount_minor::text AS "amountMinor", fee_minor::text AS "feeMinor", net_minor::text AS "netMinor",
fee_details::text AS "feeDetails", exchange_rate::text AS "exchangeRate", stripe_created::text AS created
FROM commerce.order_transaction WHERE route = :route AND balance_transaction_id = ANY(:ids::text[]) ORDER BY balance_transaction_id;
