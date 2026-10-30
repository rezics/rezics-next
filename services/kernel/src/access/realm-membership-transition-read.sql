SELECT t.proof_transaction_id::text AS "proofTransactionId", t.outcome,
       t.hold_transaction_id::text AS "holdTransactionId", t.legacy,
       EXISTS (SELECT 1 FROM access.lifecycle_coordination h
         WHERE h.route=t.route AND h.account_id=t.account_id AND h.reservation_id=t.generation_id
           AND h.related_account_id=t.realm_id AND h.purpose='membership'
           AND h.transaction_id=t.hold_transaction_id) AS held,
       a.state='active' AND NOT a.authn_fenced AND a.operator_account_id IS NULL AS active
FROM access.realm_membership_transition t
JOIN access.account a ON a.route=t.route AND a.account_id=t.account_id
WHERE t.route=:route::integer AND t.account_id=:account_id::uuid AND t.realm_id=:realm_id::uuid
 AND t.reservation_id=:reservation_id::uuid AND t.generation_id=:generation_id::uuid AND t.operation_id=:operation_id::text;
