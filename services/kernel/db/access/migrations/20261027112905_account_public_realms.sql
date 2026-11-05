-- migrate:up
ALTER TABLE access.account DROP CONSTRAINT account_public_views_check;

UPDATE access.account
SET public_views = public_views || '{"realms":false}'::jsonb;

ALTER TABLE access.account
  ALTER COLUMN public_views SET DEFAULT '{"posts":true,"reviews":true,"collections":true,"realms":false}'::jsonb,
  ADD CONSTRAINT account_public_views_check CHECK (
    jsonb_typeof(public_views) = 'object'
    AND public_views ?& ARRAY['posts', 'reviews', 'collections', 'realms']
    AND public_views - ARRAY['posts', 'reviews', 'collections', 'realms'] = '{}'::jsonb
    AND jsonb_typeof(public_views->'posts') = 'boolean'
    AND jsonb_typeof(public_views->'reviews') = 'boolean'
    AND jsonb_typeof(public_views->'collections') = 'boolean'
    AND jsonb_typeof(public_views->'realms') = 'boolean'
  );

-- migrate:down
ALTER TABLE access.account DROP CONSTRAINT account_public_views_check;

UPDATE access.account
SET public_views = public_views - 'realms';

ALTER TABLE access.account
  ALTER COLUMN public_views SET DEFAULT '{"posts":true,"reviews":true,"collections":true}'::jsonb,
  ADD CONSTRAINT account_public_views_check CHECK (
    jsonb_typeof(public_views) = 'object'
    AND public_views ?& ARRAY['posts', 'reviews', 'collections']
    AND public_views - ARRAY['posts', 'reviews', 'collections'] = '{}'::jsonb
    AND jsonb_typeof(public_views->'posts') = 'boolean'
    AND jsonb_typeof(public_views->'reviews') = 'boolean'
    AND jsonb_typeof(public_views->'collections') = 'boolean'
  );
