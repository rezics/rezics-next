UPDATE search.index_home_coverage
SET revision = revision + 1, verified = :verified::jsonb, covered_through = :covered_through::jsonb
WHERE partition_no = :partition AND consumer = :consumer AND index_uuid = :uuid
  AND revision = :revision::bigint AND revision < 9223372036854775807
RETURNING partition_no, revision::text, "current", fence, verified, covered_through, attempt;
