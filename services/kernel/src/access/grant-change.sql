WITH input AS NOT MATERIALIZED (
  SELECT :subject_kind::text AS subject_kind, :route::integer AS route, :resource_id::uuid AS resource_id, :subject_id::uuid AS subject_id,
         :subject_role::text AS subject_role, :previous_actions::text[] AS previous_actions,
         :previous_valid::tstzrange AS previous_valid
), removed AS (
  DELETE FROM access.resource_grant g USING input i
  WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.subject_id = i.subject_id
    AND g.subject_kind = i.subject_kind AND g.subject_role = i.subject_role AND g.action = ANY(i.previous_actions) AND g.valid = i.previous_valid
  RETURNING g.action
)
INSERT INTO access.resource_grant (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
SELECT i.route, i.resource_id, i.subject_kind, i.subject_id, i.subject_role, action, :valid::tstzrange, :transaction_id
FROM input i CROSS JOIN unnest(:actions::text[]) AS action
WHERE (SELECT count(*) FROM removed) = cardinality(i.previous_actions)
RETURNING action;
