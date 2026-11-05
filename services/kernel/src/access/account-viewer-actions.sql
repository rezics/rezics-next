-- Bounded full-key Account neighbourhood; no ACL, identity search or history scan.
SELECT a.account_id::text AS id, a.kind, a.state, a.authn_fenced AS fenced,
       a.operator_account_id::text AS "operatorAccountId",
       a.minimum_authn_epoch::text AS "minimumAuthnEpoch"
FROM unnest(:routes::integer[], :ids::uuid[]) wanted(route, id)
JOIN LATERAL (
  SELECT account_id, kind, state, authn_fenced, operator_account_id, minimum_authn_epoch
  FROM access.account
  WHERE route = wanted.route AND account_id = wanted.id
  LIMIT 1
) a ON true;
