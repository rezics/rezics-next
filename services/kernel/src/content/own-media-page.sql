SELECT id::text AS id
FROM content.account_upload
WHERE route = :route::integer
  AND account_id = :account_id::uuid
  AND phase = 'media'
  AND id > :after::uuid
ORDER BY id
LIMIT :limit::integer;
