-- unbound: one Global catalogue page in release_visible.
SELECT package_id, id, version, compatibility::text AS compatibility, artifact_url,
       artifact_size::text AS artifact_size, artifact_sha256, requirements::text AS requirements,
       published_at::text AS published_at
FROM launcher.release
WHERE package_id = :package_id::text AND withdrawn_at IS NULL
  AND (published_at, id) < (:after_time::timestamptz, :after_id::text)
ORDER BY launcher.release.published_at DESC, id DESC
LIMIT :limit::integer;
