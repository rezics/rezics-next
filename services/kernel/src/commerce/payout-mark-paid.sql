UPDATE commerce.payout_statement SET state = 'paid', paid_at = :at, paid_reference = :reference, revision = revision + 1
WHERE route = :route AND statement_id = :id AND state = 'open' AND period < :period
RETURNING statement_id AS id, creator_account_id AS "creatorAccountId", period, currency, money_unit::text AS "moneyUnit",
       gross_minor::text AS "grossMinor", tax_minor::text AS "taxMinor", fee_minor::text AS "feeMinor",
       dispute_fee_minor::text AS "disputeFeeMinor", refunds_minor::text AS "refundsMinor",
       chargebacks_minor::text AS "chargebacksMinor", net_receipts_minor::text AS "netReceiptsMinor",
       weighted_net_minor::text AS "weightedNetMinor", state, paid_at::text AS "paidAt",
       paid_reference AS "paidReference", revision;
