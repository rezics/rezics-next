-- migrate:up
ALTER TABLE access.account
  ADD COLUMN avatar uuid,
  ADD COLUMN public_views jsonb NOT NULL DEFAULT '{"posts":true,"reviews":true,"collections":true}'::jsonb,
  ADD COLUMN speakers_listed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT account_avatar_route_check CHECK (
    avatar IS NULL OR route = (get_byte(uuid_send(avatar), 10) * 256 + get_byte(uuid_send(avatar), 11))
  ),
  ADD CONSTRAINT account_public_views_check CHECK (
    jsonb_typeof(public_views) = 'object'
    AND public_views ?& ARRAY['posts', 'reviews', 'collections']
    AND public_views - ARRAY['posts', 'reviews', 'collections'] = '{}'::jsonb
    AND jsonb_typeof(public_views->'posts') = 'boolean'
    AND jsonb_typeof(public_views->'reviews') = 'boolean'
    AND jsonb_typeof(public_views->'collections') = 'boolean'
  );

-- migrate:down
ALTER TABLE access.account
  DROP CONSTRAINT account_public_views_check,
  DROP CONSTRAINT account_avatar_route_check,
  DROP COLUMN speakers_listed,
  DROP COLUMN public_views,
  DROP COLUMN avatar;
