WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
SELECT h.space_id AS id, h.state, h.head_revision_id, h.lifecycle_version::text,
       h.removed_at::text, h.removed_by, h.remover_role, h.removal_reason,
       (h.removed_at <= i.at AND i.at <= h.removed_at + interval '720 hours') AS restorable,
       (SELECT r.context_id FROM community.realm r WHERE r.route=h.route AND r.space_id=h.space_id AND r.state='active') AS context_id
FROM community.space h CROSS JOIN input i
WHERE h.route=:route::integer AND h.space_id=:id::uuid AND h.created_at <= i.at;
