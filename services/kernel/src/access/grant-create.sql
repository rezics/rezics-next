INSERT INTO access.resource_grant (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
SELECT :route, :resource_id, :subject_id, :subject_role, action, :valid::tstzrange, :transaction_id
FROM unnest(:actions::text[]) AS action
RETURNING action;
