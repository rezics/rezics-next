SELECT edition_id
FROM content.creator_edition
WHERE route = :route::integer AND creator_account_id = :creator_account_id::uuid
  AND edition_id > :after::uuid
ORDER BY edition_id
LIMIT :limit::integer;
