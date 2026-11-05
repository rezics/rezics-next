SELECT state, authn_fenced AS fenced
FROM access.account
WHERE route = :route AND account_id = :account_id
FOR SHARE;
