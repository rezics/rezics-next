SELECT position::text AS position, subject_id AS "subjectId"
FROM library.members_preparation_result
WHERE route = :route::integer AND owner_account_id = :owner_account_id::uuid
  AND collection_id = :collection_id::uuid AND episode_id = :episode_id::uuid
  AND position > :after::bigint
ORDER BY position
LIMIT :limit::integer;
