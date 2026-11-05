-- The lifecycle and existing home have already been locked and decoded in this transaction.
WITH input AS (
  SELECT :partition::integer AS partition_no, :consumer::text AS consumer, :uuid::text AS index_uuid,
    :revision::bigint AS revision, :current::nullable(jsonb) AS "current", :fence::nullable(jsonb) AS fence,
    :verified::nullable(jsonb) AS verified, :covered_through::nullable(jsonb) AS covered_through,
    :attempt::nullable(jsonb) AS attempt
)
INSERT INTO search.index_home_coverage
  (partition_no, consumer, index_uuid, revision, "current", fence, verified, covered_through, attempt)
SELECT partition_no, consumer, index_uuid, 1, "current", fence, verified, covered_through, attempt FROM input
WHERE revision = 0 OR EXISTS (
  SELECT 1 FROM search.index_home_coverage h WHERE h.partition_no = input.partition_no
    AND h.consumer = input.consumer AND h.index_uuid = input.index_uuid AND h.revision = input.revision
)
ON CONFLICT (partition_no, consumer, index_uuid) DO UPDATE
SET revision = index_home_coverage.revision + 1, "current" = EXCLUDED."current", fence = EXCLUDED.fence,
  verified = EXCLUDED.verified, covered_through = EXCLUDED.covered_through, attempt = EXCLUDED.attempt
WHERE index_home_coverage.revision = (SELECT revision FROM input)
  AND index_home_coverage.revision < 9223372036854775807
RETURNING partition_no, revision::text, "current", fence, verified, covered_through, attempt;
