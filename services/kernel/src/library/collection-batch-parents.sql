WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route)
SELECT collection.collection_id AS id, collection.curator_account_id AS "curatorAccountId",
       collection.state, collection.membership_kind AS "membershipKind"
FROM input CROSS JOIN unnest(:ids::uuid[]) requested(id)
CROSS JOIN LATERAL (
  SELECT c.collection_id, c.curator_account_id, c.state, c.membership_kind
  FROM library.collection c WHERE c.route=input.route AND c.collection_id=requested.id
) collection;
