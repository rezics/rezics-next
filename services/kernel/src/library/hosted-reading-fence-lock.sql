WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id
)
INSERT INTO library.hosted_reading_fence AS stored (route, account_id, subject_id, revision)
SELECT route, account_id, subject_id, 0
FROM input
ON CONFLICT (route, account_id, subject_id)
DO UPDATE SET revision = stored.revision
RETURNING revision::text AS revision;
