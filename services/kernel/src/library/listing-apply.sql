WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :collection_id::uuid AS collection_id, :collection_route::integer AS collection_route,
         :multiplicity::integer AS multiplicity, :time::timestamptz AS time,
         :transaction_id::uuid AS transaction_id
), previous AS MATERIALIZED (
  SELECT pair.multiplicity FROM library.subject_collection AS pair, input
  WHERE pair.route = input.route AND pair.subject_id = input.subject_id AND pair.collection_id = input.collection_id
), changed AS MATERIALIZED (
  SELECT input.*, (input.multiplicity > 0)::integer -
         (COALESCE((SELECT multiplicity FROM previous), 0) > 0)::integer AS delta
  FROM input
  WHERE input.multiplicity <> COALESCE((SELECT multiplicity FROM previous), 0)
), removed AS (
  DELETE FROM library.subject_collection AS pair USING changed, input
  WHERE pair.route = input.route AND pair.subject_id = changed.subject_id
    AND pair.collection_id = changed.collection_id AND changed.multiplicity = 0
  RETURNING pair.subject_id
), written AS (
  INSERT INTO library.subject_collection
    (route, subject_id, collection_id, collection_route, multiplicity, updated_at, transaction_id)
  SELECT input.route, changed.subject_id, changed.collection_id, changed.collection_route, changed.multiplicity,
         changed.time, changed.transaction_id
  FROM changed CROSS JOIN input WHERE changed.multiplicity > 0
  ON CONFLICT (route, subject_id, collection_id) DO UPDATE
  SET multiplicity = EXCLUDED.multiplicity, updated_at = EXCLUDED.updated_at,
      transaction_id = EXCLUDED.transaction_id
  RETURNING subject_id
)
INSERT INTO library.subject_listing
  (route, subject_id, public_collection_count, revision, updated_at, transaction_id)
SELECT input.route, changed.subject_id, GREATEST(changed.delta, 0), 1, changed.time, changed.transaction_id
FROM changed CROSS JOIN input
ON CONFLICT (route, subject_id) DO UPDATE
SET public_collection_count = library.subject_listing.public_collection_count +
      (SELECT delta FROM changed),
    revision = library.subject_listing.revision + 1,
    updated_at = EXCLUDED.updated_at, transaction_id = EXCLUDED.transaction_id
RETURNING public_collection_count AS "publicCollectionCount", revision;
