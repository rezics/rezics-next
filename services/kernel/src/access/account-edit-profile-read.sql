SELECT account_id AS id, kind, handle, display_name AS "displayName", biography AS bio,
       links, avatar, public_views AS "publicViews", speakers_listed AS "speakersListed",
       operator_account_id AS "operatorAccountId"
FROM access.account
WHERE route = :route AND account_id = :account_id AND state = 'active' AND NOT authn_fenced;
