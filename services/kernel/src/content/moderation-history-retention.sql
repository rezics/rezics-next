-- Exact retained metadata only; no account presentation or target body.
SELECT CASE WHEN decider_account_id IS NULL AND decided_at + interval '183 days' <= CURRENT_TIMESTAMP
            THEN '' ELSE statement END AS statement,
       decider_account_id IS NULL AS decider_retired,
       decider_account_id IS NULL AND decided_at + interval '183 days' <= CURRENT_TIMESTAMP AS statement_retired,
       recorded_transaction_id IS NOT NULL AS exact_receipt
FROM content.moderation_decision
WHERE route = :route::integer AND decision_id = :decision_id::uuid;
