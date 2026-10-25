SELECT handle FROM access.lifecycle_registration_expiry
WHERE route = :route AND account_id = :account_id AND reservation_id = :reservation_id;
