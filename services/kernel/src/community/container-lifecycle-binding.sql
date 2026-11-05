WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
SELECT r.realm_id, r.space_id, r.context_id, r.head_revision_id,
       r.lifecycle_version::text AS realm_version, s.lifecycle_version::text AS space_version,
       s.head_revision_id AS space_head,
       (SELECT p.publication_id FROM community.publication_head p
        WHERE p.route = r.route AND p.realm_id = r.realm_id AND p.subject_id = :subject::nullable(uuid)
          AND p.verdict = 'adopt') AS publication_id
FROM community.realm r CROSS JOIN input i
JOIN community.space s ON s.route = r.route AND s.space_id = r.space_id
WHERE r.route = :route::integer AND r.realm_id = :id::uuid
  AND r.state = 'active' AND s.state = 'active'
  AND r.created_at <= i.at AND s.created_at <= i.at;
