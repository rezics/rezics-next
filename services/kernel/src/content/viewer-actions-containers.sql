-- A board, its Realm and that Realm's Space are in the same partition.
WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
SELECT b.board_id AS id, b.visibility='published' AS public, b.realm_id,
       r.visibility='public' AS realm_public, r.space_id,
       NOT EXISTS (
         SELECT 1 FROM unnest(:accounts::uuid[]) AS actor(account_id)
         JOIN community.realm_ban ban ON ban.route=b.route AND ban.realm_id=b.realm_id
           AND ban.account_id=actor.account_id
         WHERE upper_inf(ban.valid) AND ban.valid @> input.at LIMIT 1
       ) AS unbanned
FROM unnest(:routes::integer[], :ids::uuid[]) AS wanted(route,id)
CROSS JOIN input
CROSS JOIN LATERAL (
  SELECT board_id, visibility, realm_id, route FROM content.board
  WHERE route=wanted.route AND board_id=wanted.id AND visibility IN ('published','protected') LIMIT 1
) b
LEFT JOIN LATERAL (
  SELECT h.realm_id, h.space_id, h.visibility
  FROM community.realm h
  JOIN community.realm_revision rev
    ON rev.route=h.route AND rev.realm_id=h.realm_id AND rev.revision_id=h.head_revision_id
  JOIN community.space s ON s.route=h.route AND s.space_id=h.space_id
  JOIN community.space_revision sr
    ON sr.route=s.route AND sr.space_id=s.space_id AND sr.revision_id=s.head_revision_id
  WHERE h.route=b.route AND h.realm_id=b.realm_id AND h.state='active' AND s.state='active'
    AND h.created_at<=input.at AND rev.created_at<=input.at
    AND s.created_at<=input.at AND sr.created_at<=input.at LIMIT 1
) r ON true
WHERE b.realm_id IS NULL OR r.realm_id IS NOT NULL;
