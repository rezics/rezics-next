WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :collection_id::uuid AS collection_id)
SELECT member.member_id AS id, member.subject_id AS "subjectId"
FROM input CROSS JOIN unnest(:ids::uuid[]) requested(id)
CROSS JOIN LATERAL (
  SELECT m.member_id, m.subject_id FROM library.collection_member m
  WHERE m.route=input.route AND m.collection_id=input.collection_id AND m.member_id=requested.id
) member;
