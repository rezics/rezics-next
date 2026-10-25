WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id, :role::text AS role
)
INSERT INTO access.resource_grant (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
SELECT i.route, i.account_id, i.subject_id, i.role, requested.action, '(,)'::tstzrange, :transaction_id
FROM input i CROSS JOIN unnest(:actions::text[]) AS requested(action)
-- Never replace or widen an existing native validity range, even expired history.
WHERE (requested.action <> 'account:manage' OR i.subject_id <> i.account_id OR i.role <> '' OR EXISTS (
  SELECT 1 FROM access.account a WHERE a.route = i.route AND a.account_id = i.account_id
    AND a.kind = 'actor' AND a.operator_account_id IS NULL
)) AND NOT EXISTS (
  SELECT 1 FROM access.resource_grant g
  WHERE g.route = i.route AND g.resource_id = i.account_id
    AND g.subject_kind = 'identity' AND g.subject_id = i.subject_id
    AND g.subject_role = i.role AND g.action = requested.action
)
RETURNING action;
