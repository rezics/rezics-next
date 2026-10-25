WITH input AS NOT MATERIALIZED (SELECT :operator_id::uuid AS operator_id)
INSERT INTO access.resource_grant
  (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
SELECT :route, i.operator_id, i.operator_id, :role, :action, '(,)'::tstzrange, :transaction_id
FROM input i
ON CONFLICT DO NOTHING;
