-- Pin identities before their exact revision joins. Never enumerate Realm or
-- publication history, and never replace the requested Subject with a redirect.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm::uuid AS realm,
         :subject::uuid AS subject, :at::timestamptz AS at
), realm AS MATERIALIZED (
  SELECT r.route, r.realm_id, r.space_id, r.context_id, r.head_revision_id,
         r.lifecycle_version::text AS realm_version, r.ownership_state
  FROM community.realm r CROSS JOIN input i
  WHERE r.route = i.route AND r.realm_id = i.realm
    AND r.state = 'active' AND r.created_at <= i.at
), host AS MATERIALIZED (
  SELECT s.route, s.space_id, s.head_revision_id,
         s.lifecycle_version::text AS space_version
  FROM realm r JOIN community.space s
    ON s.route = r.route AND s.space_id = r.space_id
  CROSS JOIN input i
  WHERE s.state = 'active' AND s.created_at <= i.at
), head AS MATERIALIZED (
  SELECT p.publication_id, p.verdict, p.published_at
  FROM community.publication_head p CROSS JOIN input i
  WHERE p.route = i.route AND p.realm_id = i.realm AND p.subject_id = i.subject
)
SELECT r.realm_id, r.space_id, r.context_id, r.head_revision_id AS realm_head,
       r.realm_version, r.ownership_state, s.head_revision_id AS space_head,
       s.space_version, rr.title AS realm_title, sr.title AS space_title,
       h.publication_id, h.verdict,
       to_char(h.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at
FROM realm r JOIN host s ON s.route = r.route AND s.space_id = r.space_id
CROSS JOIN input i
JOIN community.realm_revision rr
  ON rr.route = i.route AND rr.realm_id = r.realm_id AND rr.revision_id = r.head_revision_id
JOIN community.space_revision sr
  ON sr.route = i.route AND sr.space_id = s.space_id AND sr.revision_id = s.head_revision_id
LEFT JOIN head h ON true
WHERE rr.created_at <= i.at AND sr.created_at <= i.at;
