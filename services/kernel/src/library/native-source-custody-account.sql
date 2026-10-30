SELECT state, authn_fenced AS fenced, minimum_authn_epoch::text AS epoch
FROM access.account WHERE route=:account_route AND account_id=:account_id FOR SHARE;
