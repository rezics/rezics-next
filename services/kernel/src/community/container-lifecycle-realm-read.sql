WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
SELECT h.realm_id AS id, h.state, h.head_revision_id, h.lifecycle_version::text,
       h.removed_at::text, h.removed_by, h.remover_role, h.removal_reason,
       (h.removed_at <= i.at AND i.at <= h.removed_at + interval '720 hours') AS restorable, h.context_id, h.space_id
FROM community.realm h CROSS JOIN input i
WHERE h.route=:route::integer AND h.realm_id=:id::uuid AND h.created_at <= i.at AND EXISTS (SELECT 1 FROM community.space s WHERE s.route=h.route AND s.space_id=h.space_id AND s.state='active');
