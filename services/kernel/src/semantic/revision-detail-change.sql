WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :revision::integer AS revision
)
SELECT 'candidate'::text AS kind, c.candidate_id::text AS candidate,
       c.property, c.slot_id::text AS slot, NULL::text AS context,
       NULL::integer AS head, NULL::text AS verdict, NULL::text AS mode,
       NULL::jsonb AS selection
FROM input i JOIN semantic.candidate c
  ON c.route = i.route AND c.subject_id = i.subject_id AND c.revision = i.revision
WHERE :kind::text = 'propose'
UNION ALL
SELECT 'decision', a.candidate_id::text, c.property, c.slot_id::text,
       a.context_id::text, a.head, a.verdict, NULL, NULL
FROM input i JOIN semantic.acceptance a
  ON a.route = i.route AND a.subject_id = i.subject_id AND a.revision = i.revision
JOIN semantic.candidate c
  ON c.route = i.route AND c.subject_id = i.subject_id AND c.candidate_id = a.candidate_id
WHERE :kind::text IN ('accept', 'reject')
UNION ALL
SELECT 'adoption', NULL, p.property, a.slot_id::text, a.context_id::text,
       a.head, NULL, a.mode, a.selection
FROM input i JOIN semantic.adoption a
  ON a.route = i.route AND a.subject_id = i.subject_id AND a.revision = i.revision
JOIN LATERAL (
  SELECT c.property FROM semantic.candidate c
  WHERE c.route = i.route AND c.subject_id = i.subject_id AND c.slot_id = a.slot_id
  LIMIT 1
) p ON true
WHERE :kind::text = 'adopt'
LIMIT 2;
