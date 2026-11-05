SELECT kind = 'organization' AND state = 'active' AND NOT authn_fenced AND speakers_listed AS listed
FROM access.account
WHERE route = :route::integer AND account_id = :account_id::uuid;
