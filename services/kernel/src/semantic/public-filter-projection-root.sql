-- Keep a missing release, home, privacy floor or Subject distinguishable on this read snapshot.
WITH input AS (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :meaning_digest::text AS digest, :with_build::boolean AS with_build, :probe_limit::integer AS probe_limit
)
SELECT EXISTS (SELECT 1 FROM core.partition WHERE partition_no = 0 AND write_state = 'active') AS release_owner,
       EXISTS (SELECT 1 FROM semantic.definition_release WHERE route = 0 AND digest = i.digest) AS installed,
       p.node, p.write_state, p.moved_to, p.epoch, p.position::text AS owner_position,
       privacy.position::text AS privacy_position,
       CASE WHEN s.subject_id IS NOT NULL THEN jsonb_build_object(
         'route', s.route, 'id', s.subject_id, 'type', s.type, 'visibility', s.visibility,
         'securityRevision', s.security_revision::text, 'currentRelease', s.current_release, 'redirect', redirect.target,
         'selection_ready', coalesce(selection.ready, false), 'current_revision', revision.revision
       ) END AS subject,
       b.build_id IS NOT NULL AS has_prior,
       coalesce(b.meaning_digest = 'retiring', false) AS retiring,
       CASE WHEN NOT i.with_build AND b.build_id IS NOT NULL THEN (
         SELECT count(*)::integer FROM (
           SELECT h.partition_no FROM semantic.public_filter_projection_head h
           WHERE (h.build_id,h.partition_no) BETWEEN (b.build_id,0) AND (b.build_id,4095)
           ORDER BY h.build_id,h.partition_no LIMIT i.probe_limit
         ) prior_heads
       ) ELSE 0 END AS probed_heads,
       CASE WHEN i.with_build AND b.meaning_digest = i.digest THEN jsonb_build_object(
         'route', b.route, 'build_id', b.build_id, 'generation', b.generation::text, 'owner_epoch', b.owner_epoch,
         'source_position', b.source_position::text, 'privacy_position', b.privacy_position::text,
         'terminal_id', b.terminal_id, 'subject_revision', b.subject_revision,
         'security_revision', b.security_revision::text, 'current_release', b.current_release
       ) END AS build
FROM input i
LEFT JOIN core.partition p ON p.partition_no = i.route / 16
LEFT JOIN semantic.public_filter_privacy_head privacy ON privacy.partition_no = p.partition_no
LEFT JOIN semantic.subject s ON (s.route, s.subject_id) = (i.route, i.subject_id)
LEFT JOIN LATERAL (
  SELECT ready FROM semantic.search_selection_state
  WHERE (route, subject_id) BETWEEN (i.route, i.subject_id) AND (i.route, i.subject_id)
  ORDER BY route, subject_id LIMIT 1
) selection ON true
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect WHERE (route, subject_id) = (i.route, i.subject_id)
  ORDER BY sequence DESC LIMIT 1
) redirect ON true
LEFT JOIN LATERAL (
  SELECT revision FROM semantic.revision WHERE (route, subject_id) = (i.route, i.subject_id)
  ORDER BY revision DESC LIMIT 1
) revision ON true
LEFT JOIN semantic.public_filter_projection_build b ON (b.partition_no, b.subject_id) = (i.route / 16, i.subject_id) AND b.route = i.route;
