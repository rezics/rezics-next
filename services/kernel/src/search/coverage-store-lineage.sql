-- The transaction holds the prefix control row lock across retained-count admission.
WITH input AS (
  SELECT :consumer::text AS consumer, :uuid::text AS uuid, :prefix::text AS prefix,
    :generation::bigint AS generation, :index::text AS index, :protocol::text AS protocol, :origin::text AS origin
), admitted AS (
INSERT INTO search.index_incarnation
  (partition_no, consumer, index_uuid, prefix, generation, index_name, protocol, revision,
   state, origin, population_partition, population_after, population_complete)
SELECT 0, consumer, uuid, prefix, generation, index, protocol, 1, 'populating', origin, 0, NULL, false FROM input
WHERE NOT (SELECT allocation_bound FROM search.index_prefix_control WHERE partition_no = 0 AND prefix = input.prefix)
  AND (SELECT count(*) FROM search.index_incarnation c WHERE c.partition_no = 0 AND c.prefix = input.prefix) < 3
ON CONFLICT DO NOTHING
RETURNING prefix, generation::double precision, index_name, index_uuid, protocol, consumer,
  revision::text, state, origin, population_partition, population_after, population_complete
), claimed AS (
  UPDATE search.index_prefix_control SET allocation_bound = true
  WHERE partition_no = 0 AND prefix = (SELECT prefix FROM input) AND EXISTS (SELECT 1 FROM admitted)
  RETURNING prefix
)
SELECT admitted.* FROM admitted JOIN claimed USING (prefix);
