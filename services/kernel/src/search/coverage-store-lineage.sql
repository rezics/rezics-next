-- The transaction holds the prefix control row lock across retained-count admission.
INSERT INTO search.index_incarnation
  (partition_no, consumer, index_uuid, prefix, generation, index_name, protocol, revision,
   state, origin, population_partition, population_after, population_complete)
SELECT 0, :consumer::text, :uuid::text, :prefix::text, :generation::bigint, :index::text,
  :protocol::text, 1, 'populating', :origin::text, 0, NULL, false
WHERE (SELECT count(*) FROM search.index_incarnation WHERE partition_no = 0 AND prefix = :prefix::text) < 3
ON CONFLICT DO NOTHING
RETURNING prefix, generation::double precision, index_name, index_uuid, protocol, consumer,
  revision::text, state, origin, population_partition, population_after, population_complete;
