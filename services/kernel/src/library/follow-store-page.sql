WITH args AS (
  SELECT :account_id::uuid AS account_id,
         :target_type::text AS target_type,
         :has_target_type::boolean AS has_target_type,
