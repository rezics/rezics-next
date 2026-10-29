WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :collection_id::uuid AS collection_id, :collection_route::integer AS collection_route,
         :multiplicity::integer AS multiplicity, :time::timestamptz AS time,
         :transaction_id::uuid AS transaction_id, :source_partition::integer AS source_partition,
         :source_epoch::integer AS source_epoch, :source_position::bigint AS source_position,
         :ever_public::boolean AS ever_public
), previous AS MATERIALIZED (
  SELECT pair.multiplicity FROM library.subject_collection AS pair, input
  WHERE pair.route = input.route AND pair.subject_id = input.subject_id AND pair.collection_id = input.collection_id
), version AS (
  INSERT INTO library.subject_collection_version
    (route, subject_id, collection_id, collection_route, source_partition, source_epoch, source_position,
     multiplicity, updated_at, transaction_id)
  SELECT input.route, subject_id, collection_id, collection_route, source_partition, source_epoch, source_position,
         input.multiplicity, time, transaction_id
  FROM input
  WHERE (ever_public OR EXISTS (SELECT 1 FROM previous))
    AND NOT EXISTS (
      SELECT 1 FROM library.subject_collection_source_fence AS fence
      WHERE fence.partition_no = input.route >> 4 AND fence.collection_id = input.collection_id
        AND (fence.terminal OR (fence.source_epoch, fence.source_position) > (input.source_epoch, input.source_position))
    )
  ON CONFLICT (route, subject_id, collection_id) DO UPDATE
  SET source_epoch = EXCLUDED.source_epoch, source_position = EXCLUDED.source_position,
      multiplicity = EXCLUDED.multiplicity, updated_at = EXCLUDED.updated_at, transaction_id = EXCLUDED.transaction_id
  WHERE (EXCLUDED.source_epoch, EXCLUDED.source_position) >
        (subject_collection_version.source_epoch, subject_collection_version.source_position)
     OR ((EXCLUDED.source_epoch, EXCLUDED.source_position) =
         (subject_collection_version.source_epoch, subject_collection_version.source_position)
         AND EXCLUDED.multiplicity <> subject_collection_version.multiplicity)
  RETURNING subject_id
), changed AS MATERIALIZED (
  SELECT input.*, (input.multiplicity > 0)::integer -
         (COALESCE((SELECT multiplicity FROM previous), 0) > 0)::integer AS delta
  FROM input
  WHERE EXISTS (SELECT 1 FROM version)
    AND input.multiplicity <> COALESCE((SELECT multiplicity FROM previous), 0)
), removed AS (
  DELETE FROM library.subject_collection AS pair USING changed
  WHERE pair.route = changed.route AND pair.subject_id = changed.subject_id
    AND pair.collection_id = changed.collection_id AND changed.multiplicity = 0
  RETURNING pair.subject_id
), written AS (
  INSERT INTO library.subject_collection
    (route, subject_id, collection_id, collection_route, multiplicity, updated_at, transaction_id,
     source_partition, source_epoch, source_position)
  SELECT input.route, subject_id, collection_id, collection_route, multiplicity, time, transaction_id,
         source_partition, source_epoch, source_position
  FROM input WHERE EXISTS (SELECT 1 FROM version) AND multiplicity > 0
  ON CONFLICT (route, subject_id, collection_id) DO UPDATE
  SET multiplicity = EXCLUDED.multiplicity,
      updated_at = CASE WHEN subject_collection.multiplicity <> EXCLUDED.multiplicity THEN EXCLUDED.updated_at ELSE subject_collection.updated_at END,
      transaction_id = CASE WHEN subject_collection.multiplicity <> EXCLUDED.multiplicity THEN EXCLUDED.transaction_id ELSE subject_collection.transaction_id END,
      source_partition = EXCLUDED.source_partition,
      source_epoch = EXCLUDED.source_epoch, source_position = EXCLUDED.source_position
  RETURNING subject_id
), aggregate AS (
  INSERT INTO library.subject_listing
    (route, subject_id, public_collection_count, revision, updated_at, transaction_id)
  SELECT route, subject_id, GREATEST(delta, 0), 1, time, transaction_id FROM changed
  ON CONFLICT (route, subject_id) DO UPDATE
  SET public_collection_count = library.subject_listing.public_collection_count + (SELECT delta FROM changed),
      revision = library.subject_listing.revision + 1,
      updated_at = EXCLUDED.updated_at, transaction_id = EXCLUDED.transaction_id
  RETURNING public_collection_count AS "publicCollectionCount", revision
)
SELECT EXISTS (SELECT 1 FROM version) AS advanced,
       EXISTS (SELECT 1 FROM changed) AS "projectionChanged",
       (SELECT "publicCollectionCount" FROM aggregate) AS "publicCollectionCount",
       (SELECT revision FROM aggregate) AS revision
LIMIT 1;
