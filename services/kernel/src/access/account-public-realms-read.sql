SELECT state = 'active' AND NOT authn_fenced AND membership_inverse_complete
       AND public_views->'realms' = 'true'::jsonb AS enabled
FROM access.account
WHERE route = :route::integer AND account_id = :account_id::uuid;
