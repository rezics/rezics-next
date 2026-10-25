INSERT INTO access.lifecycle_coordination
  (route, account_id, reservation_id, related_account_id, purpose, transaction_id)
VALUES (:route, :operator_id, :reservation_id, :subject_id, 'operator', :transaction_id);
