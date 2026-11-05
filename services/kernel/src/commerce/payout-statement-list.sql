SELECT statement_id AS id, creator_account_id AS "creatorAccountId", period, currency, money_unit::text AS "moneyUnit",
       gross_minor::text AS "grossMinor", tax_minor::text AS "taxMinor", fee_minor::text AS "feeMinor",
       dispute_fee_minor::text AS "disputeFeeMinor", refunds_minor::text AS "refundsMinor",
       chargebacks_minor::text AS "chargebacksMinor", net_receipts_minor::text AS "netReceiptsMinor",
       weighted_net_minor::text AS "weightedNetMinor", state, paid_at::text AS "paidAt",
       paid_reference AS "paidReference", revision
FROM commerce.payout_statement WHERE route = :route AND creator_account_id = :creator
AND statement_id < :after::uuid ORDER BY statement_id DESC LIMIT :limit;
