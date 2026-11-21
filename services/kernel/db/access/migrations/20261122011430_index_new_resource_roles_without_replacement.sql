-- migrate:up
CREATE FUNCTION access.index_current_resource_role(source access.resource_role_grant, replace_existing boolean) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE anchor timestamptz;
BEGIN
  INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
  SELECT source.route,source.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
  ON CONFLICT DO NOTHING;
  UPDATE access.current_resource_role_frontier SET version=version+1
  WHERE route=source.route AND resource_id=source.resource_id RETURNING processed_at INTO STRICT anchor;
  IF replace_existing THEN
    DELETE FROM access.current_resource_role_key WHERE interval_key=source.erasure_key;
    DELETE FROM access.current_resource_role_due WHERE interval_key=source.erasure_key;
  END IF;
  IF source.valid @> anchor THEN
    INSERT INTO access.current_resource_role_key VALUES
      (source.route,source.resource_id,source.grant_role,source.subject_kind,source.subject_id,source.subject_role,source.erasure_key);
  END IF;
  INSERT INTO access.current_resource_role_due
    SELECT source.route,source.resource_id,boundary,source.erasure_key
    FROM (VALUES (lower(source.valid)),(upper(source.valid))) b(boundary)
    WHERE boundary > anchor ON CONFLICT DO NOTHING;
END; $$;

CREATE OR REPLACE FUNCTION access.index_current_resource_role(source access.resource_role_grant) RETURNS void
LANGUAGE sql AS $$
  SELECT access.index_current_resource_role(source, true)
$$;

CREATE OR REPLACE FUNCTION access.capture_current_resource_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- Even deletion of the final source row advances the native resource version.
    INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
    SELECT OLD.route,OLD.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
    ON CONFLICT DO NOTHING;
    UPDATE access.current_resource_role_frontier SET version=version+1
    WHERE route=OLD.route AND resource_id=OLD.resource_id;
    DELETE FROM access.current_resource_role_key WHERE interval_key=OLD.erasure_key;
    DELETE FROM access.current_resource_role_due WHERE interval_key=OLD.erasure_key;
  END IF;
  -- A new interval key has no dependent rows. An update already removed its old keys above.
  IF TG_OP <> 'DELETE' THEN PERFORM access.index_current_resource_role(NEW, false); END IF;
  RETURN NULL;
END; $$;

-- migrate:down
CREATE OR REPLACE FUNCTION access.index_current_resource_role(source access.resource_role_grant) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE anchor timestamptz;
BEGIN
  INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
  SELECT source.route,source.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
  ON CONFLICT DO NOTHING;
  UPDATE access.current_resource_role_frontier SET version=version+1
  WHERE route=source.route AND resource_id=source.resource_id RETURNING processed_at INTO STRICT anchor;
  DELETE FROM access.current_resource_role_key WHERE interval_key=source.erasure_key;
  DELETE FROM access.current_resource_role_due WHERE interval_key=source.erasure_key;
  IF source.valid @> anchor THEN
    INSERT INTO access.current_resource_role_key VALUES
      (source.route,source.resource_id,source.grant_role,source.subject_kind,source.subject_id,source.subject_role,source.erasure_key);
  END IF;
  INSERT INTO access.current_resource_role_due
    SELECT source.route,source.resource_id,boundary,source.erasure_key
    FROM (VALUES (lower(source.valid)),(upper(source.valid))) b(boundary)
    WHERE boundary > anchor ON CONFLICT DO NOTHING;
END; $$;
CREATE OR REPLACE FUNCTION access.capture_current_resource_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- Even deletion of the final source row advances the native resource version.
    INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
    SELECT OLD.route,OLD.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
    ON CONFLICT DO NOTHING;
    UPDATE access.current_resource_role_frontier SET version=version+1
    WHERE route=OLD.route AND resource_id=OLD.resource_id;
    DELETE FROM access.current_resource_role_key WHERE interval_key=OLD.erasure_key;
    DELETE FROM access.current_resource_role_due WHERE interval_key=OLD.erasure_key;
  END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM access.index_current_resource_role(NEW); END IF;
  RETURN NULL;
END; $$;
DROP FUNCTION access.index_current_resource_role(access.resource_role_grant,boolean);
