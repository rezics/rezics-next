-- One home and exact original/terminal/related keys. No display/history hydration.
SELECT s.subject_id::text AS id, s.type, s.visibility,
       s.security_revision::text AS security, s.current_release AS release,
       r.revision, basis.epoch AS source_epoch, basis.position::text AS source_position, redirect.target::text AS redirect, agent.account_id::text AS account
FROM unnest($1::integer[], $2::uuid[]) wanted(route, id)
JOIN LATERAL (
  SELECT subject_id, type, visibility, security_revision, current_release
  FROM semantic.subject WHERE route=wanted.route AND subject_id=wanted.id LIMIT 1
) s ON true
LEFT JOIN LATERAL (
  SELECT revision, recorded_transaction_id FROM semantic.revision WHERE route=wanted.route AND subject_id=wanted.id
  ORDER BY revision DESC LIMIT 1
) r ON true
LEFT JOIN LATERAL (
  SELECT epoch, position FROM editorial.write_basis
  WHERE partition_no=(wanted.route / 16) AND transaction_id=r.recorded_transaction_id LIMIT 1
) basis ON true
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect WHERE route=wanted.route AND subject_id=wanted.id
  ORDER BY sequence DESC LIMIT 1
) redirect ON true
LEFT JOIN LATERAL (
  SELECT account_id FROM semantic.account_agent_subject
  WHERE route=wanted.route AND subject_id=wanted.id LIMIT 1
) agent ON true
ORDER BY wanted.id;
