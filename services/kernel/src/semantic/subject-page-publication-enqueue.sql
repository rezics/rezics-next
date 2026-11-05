WITH input AS NOT MATERIALIZED (SELECT :generation::bigint AS generation, :high_water::bigint AS high_water)
INSERT INTO semantic.subject_page_repair(route,subject_id,generation,high_water,replay_position)
VALUES (:route::integer,:subject_id::uuid,(SELECT generation FROM input),(SELECT high_water FROM input),(SELECT high_water FROM input))
ON CONFLICT(route,subject_id) DO UPDATE SET
version=subject_page_repair.version+CASE WHEN subject_page_repair.state='done' THEN 1 ELSE 0 END,
generation=CASE WHEN subject_page_repair.state='done' THEN (SELECT generation FROM input) ELSE subject_page_repair.generation END,
phase=CASE WHEN subject_page_repair.state='done' THEN 'descriptive' ELSE subject_page_repair.phase END,
source_key=CASE WHEN subject_page_repair.state='done' THEN '{}'::text[] ELSE subject_page_repair.source_key END,
high_water=CASE WHEN subject_page_repair.state='done' THEN (SELECT high_water FROM input) ELSE subject_page_repair.high_water END,
replay_position=CASE WHEN subject_page_repair.state='done' THEN (SELECT high_water FROM input) ELSE subject_page_repair.replay_position END,
state=CASE WHEN subject_page_repair.state='done' THEN 'pending' ELSE subject_page_repair.state END,
available_at=CASE WHEN subject_page_repair.state='done' THEN now() ELSE subject_page_repair.available_at END,
dirty=CASE WHEN subject_page_repair.state='done' THEN false ELSE subject_page_repair.dirty OR :invalidate::boolean END
RETURNING version::text,generation::text;
