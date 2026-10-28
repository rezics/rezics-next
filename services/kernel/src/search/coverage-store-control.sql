INSERT INTO search.index_prefix_control (partition_no, prefix, revision, issued_generation)
SELECT 0, :prefix::text, 1, :generation::bigint WHERE :revision::bigint = 0 OR EXISTS (SELECT 1 FROM search.index_prefix_control WHERE partition_no=0 AND prefix=:prefix::text AND revision=:revision::bigint)
ON CONFLICT (partition_no, prefix) DO UPDATE
SET revision = index_prefix_control.revision + 1, issued_generation = :generation::bigint
WHERE index_prefix_control.revision = :revision::bigint
  AND index_prefix_control.revision < 9223372036854775807
  AND index_prefix_control.issued_generation < :generation::bigint
RETURNING prefix, revision::text, issued_generation::double precision AS "issuedGeneration";
