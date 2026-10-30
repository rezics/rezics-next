WITH subjects AS MATERIALIZED (
  SELECT route, subject_id
  FROM jsonb_to_recordset(:subjects::jsonb) AS input(route integer, subject_id uuid)
), points AS (
  INSERT INTO semantic.subject_page_publication(route, subject_id)
  SELECT route, subject_id FROM subjects
  ON CONFLICT (route, subject_id) DO NOTHING
  RETURNING route, subject_id, generation, change_position
), desired AS (
  SELECT subjects.route, subjects.subject_id, point.generation + 1 AS generation,
         point.change_position AS high_water
  FROM subjects
  JOIN semantic.subject_page_publication point USING (route, subject_id)
  UNION ALL
  -- Newly inserted points are visible through RETURNING, not the statement snapshot.
  SELECT route, subject_id, generation + 1, change_position FROM points
)
INSERT INTO semantic.subject_page_repair(route, subject_id, generation, high_water, replay_position)
SELECT route, subject_id, generation, high_water, high_water FROM desired
ON CONFLICT (route, subject_id) DO UPDATE SET
  version=subject_page_repair.version+CASE WHEN subject_page_repair.state='done' THEN 1 ELSE 0 END,
  generation=CASE WHEN subject_page_repair.state='done' THEN EXCLUDED.generation ELSE subject_page_repair.generation END,
  phase=CASE WHEN subject_page_repair.state='done' THEN 'descriptive' ELSE subject_page_repair.phase END,
  source_key=CASE WHEN subject_page_repair.state='done' THEN '{}'::text[] ELSE subject_page_repair.source_key END,
  high_water=CASE WHEN subject_page_repair.state='done' THEN EXCLUDED.high_water ELSE subject_page_repair.high_water END,
  replay_position=CASE WHEN subject_page_repair.state='done' THEN EXCLUDED.replay_position ELSE subject_page_repair.replay_position END,
  state=CASE WHEN subject_page_repair.state='done' THEN 'pending' ELSE subject_page_repair.state END,
  available_at=CASE WHEN subject_page_repair.state='done' THEN now() ELSE subject_page_repair.available_at END,
  dirty=CASE WHEN subject_page_repair.state='done' THEN false ELSE subject_page_repair.dirty OR true END;
