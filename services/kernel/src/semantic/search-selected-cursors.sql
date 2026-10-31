SELECT r.*, COALESCE(c.after_slot, '00000000-0000-0000-0000-000000000000'::uuid)::text AS after_slot,
  COALESCE(c.after_candidate, '00000000-0000-0000-0000-000000000000'::uuid)::text AS after_candidate
FROM jsonb_to_recordset(:requests::jsonb) AS r(route integer, subject_id uuid, property text, value text, revision integer)
LEFT JOIN semantic.search_relation_probe c ON c.route = r.route AND c.subject_id = r.subject_id
  AND c.property = r.property COLLATE "C" AND c.value = r.value COLLATE "C" AND c.revision = r.revision;
