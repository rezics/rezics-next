SELECT balance_transaction_id AS id, money_unit::text AS "moneyUnit"
FROM commerce.royalty_line
WHERE route = :route AND balance_transaction_id = ANY(:ids::text[])
ORDER BY balance_transaction_id;
