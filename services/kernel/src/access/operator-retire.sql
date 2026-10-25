INSERT INTO access.operator_relation_slot
  (route, subject_account_id, reservation_id, operator_account_id, terminal, transaction_id)
VALUES (:route, :subject_id, :reservation_id, :operator_id, true, :transaction_id)
ON CONFLICT (route, subject_account_id, reservation_id) DO UPDATE
SET terminal = true, transaction_id = EXCLUDED.transaction_id
WHERE access.operator_relation_slot.operator_account_id = EXCLUDED.operator_account_id
RETURNING reservation_id;
