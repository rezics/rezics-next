WITH args AS NOT MATERIALIZED (SELECT :partition::integer AS partition, :after_route::nullable(integer) AS after_route, :after_owner::nullable(uuid) AS after_owner, :after_collection::nullable(uuid) AS after_collection, :after_episode::nullable(uuid) AS after_episode),
input AS NOT MATERIALIZED (SELECT :after_at::nullable(timestamptz) AS after_at),
live AS MATERIALIZED (
SELECT route, owner_account_id AS "ownerAccountId", collection_id AS "collectionId", episode_id AS "episodeId",
       last_read_at::text AS "lastReadAt"
FROM library.members_preparation
WHERE (route >> 4) = (SELECT partition FROM args) AND state = 'live'
  AND last_read_at <= :cutoff::timestamptz - interval '24 hours'
  AND ((SELECT after_at FROM input) IS NULL OR
    (last_read_at, route, owner_account_id, collection_id, episode_id) >
    ((SELECT after_at FROM input), (SELECT after_route FROM args), (SELECT after_owner FROM args), (SELECT after_collection FROM args), (SELECT after_episode FROM args)))
ORDER BY last_read_at, route, owner_account_id, collection_id, episode_id
LIMIT 8
), retired AS MATERIALIZED (
SELECT route, owner_account_id AS "ownerAccountId", collection_id AS "collectionId", episode_id AS "episodeId",
       last_read_at::text AS "lastReadAt"
FROM library.members_preparation
WHERE (route >> 4) = (SELECT partition FROM args) AND state = 'retired'
  AND ((SELECT after_at FROM input) IS NULL OR
    (last_read_at, route, owner_account_id, collection_id, episode_id) >
    ((SELECT after_at FROM input), (SELECT after_route FROM args), (SELECT after_owner FROM args), (SELECT after_collection FROM args), (SELECT after_episode FROM args)))
ORDER BY last_read_at, route, owner_account_id, collection_id, episode_id
LIMIT 8
)
SELECT * FROM (SELECT * FROM live UNION ALL SELECT * FROM retired) AS candidates
ORDER BY "lastReadAt"::timestamptz, route, "ownerAccountId", "collectionId", "episodeId" LIMIT 8;
