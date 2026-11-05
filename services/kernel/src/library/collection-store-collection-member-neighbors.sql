WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :kind::text AS kind, :excluded_ids::uuid[] AS excluded_ids, :member_id::nullable(uuid) AS member_id
), target AS (
  SELECT member.ordinal_key
  FROM library.collection_member
    AS member CROSS JOIN input
  WHERE member.route = input.route AND member.collection_id = input.collection_id
    AND member.deletion_id IS NULL
    AND NOT (member.member_id = ANY(input.excluded_ids))
    AND input.kind = 'after' AND member.member_id = input.member_id
), before_member AS (
  (SELECT member.ordinal_key
   FROM library.collection_member AS member CROSS JOIN input
   WHERE input.kind = 'last' AND member.route = input.route AND member.collection_id = input.collection_id
     AND member.deletion_id IS NULL AND NOT (member.member_id = ANY(input.excluded_ids))
   ORDER BY member.ordinal_key DESC, member.member_id DESC LIMIT 1)
  UNION ALL
  SELECT neighbour.ordinal_key FROM input CROSS JOIN target CROSS JOIN LATERAL (
    SELECT member.ordinal_key FROM library.collection_member AS member
    WHERE member.route = input.route AND member.collection_id = input.collection_id
      AND member.deletion_id IS NULL AND NOT (member.member_id = ANY(input.excluded_ids))
      AND member.ordinal_key <= target.ordinal_key
    ORDER BY member.ordinal_key DESC, member.member_id DESC LIMIT 1
  ) neighbour WHERE input.kind = 'after'
), after_member AS (
  (SELECT member.ordinal_key
   FROM library.collection_member AS member CROSS JOIN input
   WHERE input.kind = 'first' AND member.route = input.route AND member.collection_id = input.collection_id
     AND member.deletion_id IS NULL AND NOT (member.member_id = ANY(input.excluded_ids))
   ORDER BY member.ordinal_key, member.member_id LIMIT 1)
  UNION ALL
  SELECT neighbour.ordinal_key FROM input CROSS JOIN target CROSS JOIN LATERAL (
    SELECT member.ordinal_key FROM library.collection_member AS member
    WHERE member.route = input.route AND member.collection_id = input.collection_id
      AND member.deletion_id IS NULL AND NOT (member.member_id = ANY(input.excluded_ids))
      AND member.ordinal_key > target.ordinal_key
    ORDER BY member.ordinal_key, member.member_id LIMIT 1
  ) neighbour WHERE input.kind = 'after'
)
SELECT (SELECT ordinal_key FROM before_member) AS "beforeKey",
       (SELECT ordinal_key FROM after_member) AS "afterKey",
       (input.kind <> 'after' OR EXISTS (SELECT 1 FROM target)) AS found
FROM input;
