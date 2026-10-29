WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id, :subject_id::uuid AS subject_id
), truth AS NOT MATERIALIZED (
  SELECT input.*,
         coalesce(collection.state = 'active' AND collection.visibility = 'public', false) AS currently_public,
         CASE WHEN collection.collection_id IS NOT NULL THEN collection.listing_ever_public
           ELSE coalesce((SELECT history.ever_public FROM library.collection_listing_history AS history
                          WHERE history.route = input.route AND history.collection_id = input.collection_id), false)
         END AS ever_public
  FROM input
  LEFT JOIN library.collection ON collection.route = input.route AND collection.collection_id = input.collection_id
)
SELECT CASE WHEN currently_public THEN
         (SELECT count(*)::integer FROM library.collection_member AS member
          WHERE member.route = truth.route AND member.collection_id = truth.collection_id
            AND member.subject_id = truth.subject_id)
       ELSE 0 END AS multiplicity,
       currently_public AS "currentlyPublic",
       ever_public OR currently_public AS "everPublic"
FROM truth
LIMIT 1;
