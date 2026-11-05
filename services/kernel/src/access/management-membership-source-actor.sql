-- Current human standing only; never return private account/profile fields.
SELECT kind, state, authn_fenced AS fenced, minimum_authn_epoch::text AS floor,
       operator_account_id::text AS "operatorAccountId"
FROM access.account
WHERE route = :route AND account_id = :account_id;
