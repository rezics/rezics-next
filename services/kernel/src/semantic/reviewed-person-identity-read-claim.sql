SELECT subject_id::text AS subject, recorded_transaction_id::text AS transaction
FROM semantic.external_claim
WHERE route = :route::integer AND source = :source::text AND external_id = :external_id::text;
