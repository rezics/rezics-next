SELECT EXISTS (
  SELECT 1 FROM access.lifecycle_coordination WHERE route = :route AND account_id = :account_id
) AS held;
