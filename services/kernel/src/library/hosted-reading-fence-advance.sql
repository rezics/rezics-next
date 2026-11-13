WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id,
         :expected_revision::bigint AS expected_revision
)
UPDATE library.hosted_reading_fence AS stored
SET revision = stored.revision + 1
FROM input
WHERE stored.route = input.route
  AND stored.account_id = input.account_id
  AND stored.subject_id = input.subject_id
  AND stored.revision = input.expected_revision
  AND stored.revision < 9223372036854775807
RETURNING stored.revision::text AS revision;
