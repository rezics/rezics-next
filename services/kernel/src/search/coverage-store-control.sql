WITH input AS (
  SELECT :prefix::text AS prefix, :revision::bigint AS revision, :generation::bigint AS generation
)
INSERT INTO search.index_prefix_control (partition_no, prefix, revision, issued_generation)
SELECT 0, prefix, 1, generation FROM input
WHERE revision = 0 OR EXISTS (
  SELECT 1 FROM search.index_prefix_control c WHERE c.partition_no = 0 AND c.prefix = input.prefix
    AND c.revision = input.revision
)
ON CONFLICT (partition_no, prefix) DO UPDATE
SET revision = index_prefix_control.revision + 1, issued_generation = EXCLUDED.issued_generation, allocation_bound = false
WHERE index_prefix_control.revision = (SELECT revision FROM input)
  AND index_prefix_control.revision < 9223372036854775807
  AND index_prefix_control.issued_generation < EXCLUDED.issued_generation
RETURNING prefix, revision::text, issued_generation::double precision AS "issuedGeneration";
