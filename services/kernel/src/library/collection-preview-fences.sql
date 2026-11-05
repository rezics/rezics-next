-- One final native batch over addressed parents; no member re-scan or foreign home join.
SELECT requested.id AS "collectionId", fence.generation::text AS "nativeGeneration"
FROM unnest(:routes::integer[], :collection_ids::uuid[], :source_generations::bigint[], :revisions::integer[])
  AS requested(route, id, generation, revision)
JOIN library.collection parent
  ON parent.route = requested.route AND parent.collection_id = requested.id
  AND parent.source_generation = requested.generation AND parent.revision = requested.revision
  AND parent.state = 'active' AND parent.membership_kind = 'curated'
JOIN library.native_source_fence fence
  ON fence.route = requested.route AND fence.kind = 'collection' AND fence.owner_id = requested.id;
