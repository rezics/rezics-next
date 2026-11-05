INSERT INTO semantic.statement_disclosure
  (route, subject_id, candidate_id, target_id, account_id, property, source_order_key, target_order_key)
VALUES (:route::integer, :subject_id::uuid, :candidate_id::uuid, :target_id::uuid, :account_id::uuid, :property::text, :source_order_key::text, :target_order_key::text);
