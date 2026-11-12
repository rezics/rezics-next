WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id,
         :expected_revision::bigint AS expected_revision
)
DELETE FROM library.hosted_reading AS stored
USING input
WHERE stored.route = input.route
  AND stored.account_id = input.account_id
  AND stored.subject_id = input.subject_id
  AND stored.revision = input.expected_revision
RETURNING stored.subject_id;
