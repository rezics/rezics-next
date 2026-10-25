WITH input AS (SELECT :patch::jsonb AS patch)
UPDATE access.account
SET display_name = CASE WHEN i.patch ? 'displayName' THEN i.patch->>'displayName' ELSE display_name END,
    avatar_url = CASE WHEN i.patch ? 'avatarUrl' THEN i.patch->>'avatarUrl' ELSE avatar_url END,
    biography = CASE WHEN i.patch ? 'biography' THEN i.patch->>'biography' ELSE biography END,
    birth_date = CASE WHEN i.patch ? 'birthDate' THEN (i.patch->>'birthDate')::date ELSE birth_date END,
    content_preferences = CASE WHEN i.patch ? 'contentPreferences' THEN i.patch->'contentPreferences' ELSE content_preferences END,
    transaction_id = :transaction_id
FROM input i
WHERE route = :route AND account_id = :account_id AND state = 'active' AND NOT authn_fenced
RETURNING account_id;
