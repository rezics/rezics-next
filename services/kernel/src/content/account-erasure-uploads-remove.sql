DELETE FROM content.account_upload
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND phase = :phase::text AND id = ANY(:ids::uuid[]);
