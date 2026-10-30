WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route)
SELECT collection.collection_id AS id, collection.curator_account_id AS "curatorAccountId",
       collection.revision, collection.member_count AS "memberCount", collection.membership_kind AS "membershipKind"
FROM input CROSS JOIN unnest(:ids::uuid[]) requested(id)
CROSS JOIN LATERAL (
  SELECT c.collection_id, c.curator_account_id, c.revision, c.member_count, c.membership_kind
  FROM library.collection c
  WHERE c.route=input.route AND c.collection_id=requested.id AND c.state='active'
  FOR UPDATE
) collection
ORDER BY collection.collection_id;
