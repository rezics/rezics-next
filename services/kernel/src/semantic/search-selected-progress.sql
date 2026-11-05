WITH input AS (SELECT :progress::jsonb AS progress)
INSERT INTO semantic.search_relation_probe
  (route, subject_id, property, value, revision, after_slot, after_candidate)
SELECT route, subject_id, property, value, revision, after_slot, after_candidate
FROM input CROSS JOIN LATERAL jsonb_to_recordset(input.progress) AS p(route integer, subject_id uuid, property text, value text,
  revision integer, after_slot uuid, after_candidate uuid, previous_slot uuid, previous_candidate uuid)
ON CONFLICT (route, subject_id, property, value) DO UPDATE
  SET revision = EXCLUDED.revision, after_slot = EXCLUDED.after_slot, after_candidate = EXCLUDED.after_candidate
  WHERE semantic.search_relation_probe.revision < EXCLUDED.revision
    OR (semantic.search_relation_probe.revision = EXCLUDED.revision
      AND EXISTS (SELECT 1 FROM input CROSS JOIN LATERAL jsonb_to_recordset(input.progress) AS p(route integer, subject_id uuid, property text, value text,
        previous_slot uuid, previous_candidate uuid)
        WHERE p.route = EXCLUDED.route AND p.subject_id = EXCLUDED.subject_id
          AND p.property = EXCLUDED.property AND p.value = EXCLUDED.value
          AND p.previous_slot = semantic.search_relation_probe.after_slot
          AND p.previous_candidate = semantic.search_relation_probe.after_candidate));
