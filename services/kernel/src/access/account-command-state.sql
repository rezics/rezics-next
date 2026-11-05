SELECT kind, state, authn_fenced AS fenced, minimum_authn_epoch::text AS "minimumAuthnEpoch"
FROM access.account
WHERE route = :route AND account_id = :account_id;
