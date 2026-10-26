SELECT EXISTS (
  SELECT 1 FROM access.lifecycle_coordination
  WHERE route = :route AND account_id = :operator_id AND purpose = 'operator'
  LIMIT 1
) AS responsible;
