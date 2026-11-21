-- Only a new publication point proves an empty baseline. An existing point
-- leaves all writes to the locked transition path, including change-id replay.
WITH shown AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset(:components::jsonb) AS c(position bigint, kind text, key text, digest text)
), point AS (
  INSERT INTO semantic.subject_page_publication
    (route, subject_id, readiness, completed_position, change_position, public_effective_at, evidence, witnesses)
  SELECT :route::integer, :subject_id::uuid, 'ready', count(*), count(*),
         CASE WHEN count(*) > 0 THEN :at::timestamptz END,
         CASE WHEN count(*) > 0 THEN 'known' ELSE 'missing' END, :witnesses::jsonb
  FROM shown
  ON CONFLICT (route, subject_id) DO NOTHING
  RETURNING route, subject_id, generation, public_effective_at
), changes AS (
  INSERT INTO semantic.subject_page_change
    (route, subject_id, position, change_id, component_kind, component_key, before_state, after_state, effective_at, evidence)
  SELECT p.route, p.subject_id, c.position, :change_id::text || ':' || c.kind || ':' || c.key,
         c.kind, c.key, '{"shown":false,"digest":null}'::jsonb,
         jsonb_build_object('shown', true, 'digest', c.digest), p.public_effective_at, 'known'
  FROM point p CROSS JOIN shown c
  RETURNING route, subject_id, position, component_kind, component_key, after_state, effective_at
), components AS (
  INSERT INTO semantic.subject_page_component
    (route, subject_id, component_kind, component_key, generation, shown, digest, effective_at, evidence,
     last_change_position, source_version)
  SELECT c.route, c.subject_id, c.component_kind, c.component_key, p.generation, true, c.after_state->>'digest',
         c.effective_at, 'known', c.position, 1
  FROM changes c JOIN point p USING (route, subject_id)
)
SELECT subject_id FROM point;
