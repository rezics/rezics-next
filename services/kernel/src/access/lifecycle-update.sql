WITH input AS (SELECT :patch::jsonb AS patch)
UPDATE access.account
SET display_name = CASE WHEN i.patch ? 'displayName' THEN i.patch->>'displayName' ELSE display_name END,
    avatar_url = CASE WHEN i.patch ? 'avatarUrl' THEN i.patch->>'avatarUrl' ELSE avatar_url END,
    avatar = CASE WHEN i.patch ? 'avatar' THEN (i.patch->>'avatar')::uuid ELSE avatar END,
    public_views = CASE WHEN i.patch ? 'publicViews' THEN public_views || (i.patch->'publicViews') ELSE public_views END,
    speakers_listed = CASE WHEN i.patch ? 'speakersListed' THEN (i.patch->>'speakersListed')::boolean ELSE speakers_listed END,
    biography = CASE WHEN i.patch ? 'biography' THEN i.patch->>'biography' ELSE biography END,
    links = CASE WHEN i.patch ? 'links' THEN i.patch->'links' ELSE links END,
    birth_date = CASE WHEN i.patch ? 'birthDate' THEN (i.patch->>'birthDate')::date ELSE birth_date END,
    content_preferences = CASE WHEN i.patch ? 'contentPreferences' THEN i.patch->'contentPreferences' ELSE content_preferences END,
    transaction_id = :transaction_id
FROM input i
WHERE route = :route AND account_id = :account_id AND state = 'active' AND NOT authn_fenced
RETURNING account_id;
