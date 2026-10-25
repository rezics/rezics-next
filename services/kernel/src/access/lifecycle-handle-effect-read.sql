SELECT effect FROM access.lifecycle_handle_effect
WHERE route = :route AND normalized_handle = :handle AND account_id = :account_id
  AND reservation_id = :reservation_id AND operation_id = :operation_id AND effect = :effect;
