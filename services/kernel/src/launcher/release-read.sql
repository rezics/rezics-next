-- unbound: one Global exact immutable release key.
SELECT package_id, id, version, compatibility::text AS compatibility, artifact_url,
       artifact_size::text AS artifact_size, artifact_sha256, requirements::text AS requirements
FROM launcher.release
WHERE package_id = :package_id::text AND id = :release_id::text AND withdrawn_at IS NULL;
