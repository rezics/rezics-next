-- The lifecycle and existing home have already been locked and decoded in this transaction.
INSERT INTO search.index_home_coverage
  (partition_no, consumer, index_uuid, revision, "current", fence, verified, covered_through, attempt)
SELECT :partition::integer, :consumer::text, :uuid::text, 1,
  :current::nullable(jsonb), :fence::nullable(jsonb), :verified::nullable(jsonb),
  :covered_through::nullable(jsonb), :attempt::nullable(jsonb)
WHERE :revision::bigint = 0 OR EXISTS (SELECT 1 FROM search.index_home_coverage WHERE partition_no=:partition::integer AND consumer=:consumer::text AND index_uuid=:uuid::text AND revision=:revision::bigint)
ON CONFLICT (partition_no, consumer, index_uuid) DO UPDATE
SET revision = index_home_coverage.revision + 1, "current" = :current::nullable(jsonb),
  fence = :fence::nullable(jsonb), verified = :verified::nullable(jsonb),
  covered_through = :covered_through::nullable(jsonb), attempt = :attempt::nullable(jsonb)
WHERE index_home_coverage.revision = :revision::bigint
  AND index_home_coverage.revision < 9223372036854775807
RETURNING partition_no, revision::text, "current", fence, verified, covered_through, attempt;
