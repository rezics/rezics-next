WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :kind::text AS kind, :member_id::nullable(uuid) AS member_id
), target AS (
  SELECT member.ordinal_key
  FROM library.collection_member
    AS member CROSS JOIN input
  WHERE member.route = input.route AND member.collection_id = input.collection_id
    AND member.deletion_id IS NULL
    AND input.kind = 'after' AND member.member_id = input.member_id
), before_member AS (
  SELECT member.ordinal_key
  FROM library.collection_member AS member CROSS JOIN input
  WHERE member.route = input.route AND member.collection_id = input.collection_id
    AND member.deletion_id IS NULL
    AND (input.kind = 'last' OR (input.kind = 'after' AND member.ordinal_key <= (SELECT ordinal_key FROM target)))
  ORDER BY member.ordinal_key DESC, member.member_id DESC
  LIMIT 1
), after_member AS (
  SELECT member.ordinal_key
  FROM library.collection_member AS member CROSS JOIN input
  WHERE member.route = input.route AND member.collection_id = input.collection_id
    AND member.deletion_id IS NULL
    AND (input.kind = 'first' OR (input.kind = 'after' AND member.ordinal_key > (SELECT ordinal_key FROM target)))
  ORDER BY member.ordinal_key, member.member_id
  LIMIT 1
)
SELECT (SELECT ordinal_key FROM before_member) AS "beforeKey",
       (SELECT ordinal_key FROM after_member) AS "afterKey",
       (input.kind <> 'after' OR EXISTS (SELECT 1 FROM target)) AS found
FROM input;
