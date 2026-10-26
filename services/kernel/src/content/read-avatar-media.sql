-- The account route and exact media id bind this fact to the account's partition.
SELECT media_id
FROM content.media
WHERE route = :route::integer AND media_id = :media_id::uuid
  AND container_id = :account_id::uuid AND purpose = 'avatar' AND state = 'available'
  AND NOT erased AND NOT collection_pending AND NOT taken_down;
