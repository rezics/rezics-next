-- All addressed parents share one raw-key allowance, including empty-parent rows.
-- No occurrence annotation or private Library fact is selected.
SELECT parent.collection_id AS "collectionId", fence.generation::text AS "nativeGeneration",
       member.subject_id AS "subjectId", member.deletion_id AS "deletionId"
FROM unnest(:routes::integer[], :collection_ids::uuid[], :source_generations::bigint[], :revisions::integer[])
  WITH ORDINALITY AS requested(route, id, generation, revision, position)
JOIN LATERAL (
  SELECT collection_id, member_count
  FROM library.collection
  WHERE route = requested.route AND collection_id = requested.id
    AND source_generation = requested.generation AND revision = requested.revision
    AND state = 'active' AND membership_kind = 'curated'
  LIMIT 1
) parent ON true
JOIN library.native_source_fence fence
  ON fence.route = requested.route AND fence.kind = 'collection' AND fence.owner_id = requested.id
LEFT JOIN LATERAL (
  SELECT subject_id, ordinal_key, member_id, deletion_id
  FROM library.collection_member
  WHERE route = requested.route AND collection_id = requested.id
  ORDER BY ordinal_key, member_id
  LIMIT :per_parent
) member ON true
ORDER BY requested.position, member.ordinal_key, member.member_id;
