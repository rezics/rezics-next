-- unbound: one Global immutable release insert. Version and ID are each unique within the package.
INSERT INTO launcher.release (
    package_id, id, version, compatibility, artifact_url, artifact_size, artifact_sha256, requirements, published_at
)
VALUES (
    :package_id, :id, :version, :compatibility::text::jsonb, :artifact_url, :artifact_size::text::bigint,
    :artifact_sha256, :requirements::text::jsonb, :published_at::timestamptz
)
ON CONFLICT DO NOTHING
RETURNING id;
