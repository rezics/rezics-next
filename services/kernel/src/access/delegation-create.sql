WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route)
INSERT INTO access.principal_assignment
  (route, principal_id, creator_principal_id, request_id, assigned_actor_id, valid, transaction_id)
SELECT i.route, a.account_id, a.account_id, :request_id, :actor_id, :valid::tstzrange, :transaction_id
FROM input i JOIN access.account a ON a.route = i.route
WHERE a.account_id = :principal_id AND a.kind = 'actor'
  AND a.state = 'active' AND NOT a.authn_fenced AND a.minimum_authn_epoch <= :authn_epoch
RETURNING request_id;
