-- A mod Work lists every release its owners disclose, newest first: the version,
-- what it runs on and what it declares it needs, read from one verified native
-- receipt each. Only these public manifest facts leave the receipt; captures stay
-- in Content. 770's single binding becomes the first release of its Work.
CREATE TABLE access.mod_work_release (
  work text NOT NULL CHECK (work ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  resolution_id uuid NOT NULL UNIQUE,
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  release jsonb NOT NULL CHECK (jsonb_typeof(release) = 'object'
    AND release->>'profile' = 'mod-release-v1' AND octet_length(release::text) <= 16384),
  -- One release per version, loader and game version on a Work; another receipt for it conflicts.
  release_key text GENERATED ALWAYS AS (coalesce(release->'version', 'null')::text || ' '
    || coalesce(release->'loaders', 'null')::text || ' ' || coalesce(release->'gameVersions', 'null')::text) STORED,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (work, resolution_id),
  UNIQUE (work, release_key)
);
CREATE INDEX mod_work_release_newest ON access.mod_work_release (work, bound_at DESC, release_key DESC);

CREATE FUNCTION access.mod_work_release_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mod Work release is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER mod_work_release_immutable BEFORE UPDATE OR DELETE ON access.mod_work_release
  FOR EACH ROW EXECUTE FUNCTION access.mod_work_release_immutable();

-- A 770 card disclosed game, loader and version only; what it did not disclose stays unknown (null).
CREATE FUNCTION access.mod_card_release(card jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('profile', 'mod-release-v1', 'mod', NULL, 'version', card->'latestRelease',
    'game', card->'game', 'gameVersions', card->'gameVersions', 'loaders', card->'loaders',
    'environment', NULL, 'dependencies', NULL, 'changelog', NULL, 'capturedAt', card->'capturedAt')
$$;

INSERT INTO access.mod_work_release (work, resolution_id, principal_id, release, bound_at)
SELECT work, resolution_id, principal_id, access.mod_card_release(card), bound_at
FROM access.mod_work_binding ON CONFLICT DO NOTHING;

-- Writers that still bind through 770 list their release too.
CREATE FUNCTION access.mod_work_binding_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO access.mod_work_release (work, resolution_id, principal_id, release, bound_at)
  VALUES (NEW.work, NEW.resolution_id, NEW.principal_id, access.mod_card_release(NEW.card), NEW.bound_at)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER mod_work_binding_release AFTER INSERT ON access.mod_work_binding
  FOR EACH ROW EXECUTE FUNCTION access.mod_work_binding_release();
