SELECT account_id AS "accountId", kind, state,
       CASE WHEN state = 'active' AND NOT authn_fenced THEN avatar END AS avatar,
       CASE WHEN state = 'active' AND NOT authn_fenced
            THEN public_views || jsonb_build_object('realms', COALESCE(public_views->'realms', 'false'::jsonb))
            ELSE '{"posts":false,"reviews":false,"collections":false,"realms":false}'::jsonb END AS "publicViews",
       state = 'active' AND NOT authn_fenced AND speakers_listed AS "speakersListed",
       CASE WHEN state <> 'deleted' THEN handle END AS handle,
       CASE WHEN state <> 'deleted' THEN display_name END AS "displayName",
       CASE WHEN state <> 'deleted' THEN avatar_url END AS "avatarUrl",
       CASE WHEN state <> 'deleted' THEN biography END AS biography,
       CASE WHEN state <> 'deleted' THEN links ELSE '[]'::jsonb END AS links,
       CASE WHEN state <> 'deleted' THEN operator_account_id END AS "operatorAccountId",
       state <> 'deleted' AND agent_verified AS "agentVerified",
       CASE WHEN state <> 'deleted' AND agent_verified THEN agent_subject_id::text END AS "agentSubjectId"
FROM access.account
WHERE route = :route AND account_id = :account_id AND state <> 'pending';
