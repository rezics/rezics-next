WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :context_id::uuid AS context_id
)
SELECT base.digest, base.head, ext.digest AS "extensionDigest", ext.head AS "extensionHead"
FROM input i CROSS JOIN LATERAL (
  SELECT a.digest, a.head FROM semantic.definition_activation a
  WHERE a.route = i.route ORDER BY a.head DESC LIMIT 1
) base
LEFT JOIN LATERAL (
  SELECT h.digest, h.head FROM semantic.context_extension_head(i.route, i.context_id) h LIMIT 1
) ext ON true;
