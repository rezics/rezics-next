-- Realm identity and head revision stay in their owning partition.
WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.id
  FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
)
SELECT h.route, h.realm_id, h.state, h.visibility, h.head_revision_id,
       h.created_at, h.revision_created_at
FROM input i
CROSS JOIN LATERAL (
  SELECT h.route, h.realm_id, h.state, h.visibility, h.head_revision_id,
         h.created_at, r.created_at AS revision_created_at
  FROM community.realm h
  JOIN community.realm_revision r
    ON r.route = h.route AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
  WHERE h.route = i.route AND h.realm_id = i.id
  LIMIT 1
) h;
