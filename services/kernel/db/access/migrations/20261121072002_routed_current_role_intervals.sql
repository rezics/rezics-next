-- migrate:up
-- Installation traverses the global interval sequence. A current key or due boundary
-- already knows its grant route and can validate and retire the interval there.
DO $routed_intervals$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='access.resource_role_grant'::regclass
      AND conname='resource_role_grant_route_interval'
  ) THEN
    ALTER TABLE access.resource_role_grant ADD CONSTRAINT resource_role_grant_route_interval UNIQUE (route, erasure_key);
  END IF;
END
$routed_intervals$;
ALTER TABLE access.current_resource_role_due DROP CONSTRAINT current_resource_role_due_interval_key_fkey,
  ADD CONSTRAINT current_resource_role_due_interval_key_fkey FOREIGN KEY (route, interval_key)
  REFERENCES access.resource_role_grant (route, erasure_key) ON DELETE CASCADE;
DROP INDEX access.current_resource_role_due_source;
CREATE INDEX current_resource_role_due_source ON access.current_resource_role_due (route, interval_key);
ALTER TABLE access.current_resource_role_key DROP CONSTRAINT current_resource_role_key_interval_key_fkey,
  ADD CONSTRAINT current_resource_role_key_interval_key_fkey FOREIGN KEY (route, interval_key)
  REFERENCES access.resource_role_grant (route, erasure_key) ON DELETE CASCADE;
DROP INDEX access.current_resource_role_key_source;
CREATE INDEX current_resource_role_key_source ON access.current_resource_role_key (route, interval_key);
CREATE OR REPLACE FUNCTION access.index_current_resource_role(source access.resource_role_grant) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE anchor timestamptz;
BEGIN
  INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
  SELECT source.route,source.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
  ON CONFLICT DO NOTHING;
  UPDATE access.current_resource_role_frontier SET version=version+1
  WHERE route=source.route AND resource_id=source.resource_id RETURNING processed_at INTO STRICT anchor;
  DELETE FROM access.current_resource_role_key WHERE route=source.route AND interval_key=source.erasure_key;
  DELETE FROM access.current_resource_role_due WHERE route=source.route AND interval_key=source.erasure_key;
  IF source.valid @> anchor THEN
    INSERT INTO access.current_resource_role_key VALUES
      (source.route,source.resource_id,source.grant_role,source.subject_kind,source.subject_id,source.subject_role,source.erasure_key);
  END IF;
  INSERT INTO access.current_resource_role_due
    SELECT source.route,source.resource_id,boundary,source.erasure_key
    FROM (VALUES (lower(source.valid)),(upper(source.valid))) b(boundary)
    WHERE boundary > anchor ON CONFLICT DO NOTHING;
END; $$;
CREATE OR REPLACE FUNCTION access.capture_current_resource_role() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- Even deletion of the final source row advances the native resource version.
    INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
    SELECT OLD.route,OLD.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
    ON CONFLICT DO NOTHING;
    UPDATE access.current_resource_role_frontier SET version=version+1
    WHERE route=OLD.route AND resource_id=OLD.resource_id;
    DELETE FROM access.current_resource_role_key WHERE route=OLD.route AND interval_key=OLD.erasure_key;
    DELETE FROM access.current_resource_role_due WHERE route=OLD.route AND interval_key=OLD.erasure_key;
  END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM access.index_current_resource_role(NEW); END IF;
  RETURN NULL;
END; $$;
CREATE OR REPLACE FUNCTION access.advance_current_resource_roles(p_at timestamp with time zone DEFAULT clock_timestamp()) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE install access.current_resource_role_install; source access.resource_role_grant;
  item access.current_resource_role_due; anchor timestamptz; touched integer := 0;
BEGIN
  SELECT * INTO STRICT install FROM access.current_resource_role_install WHERE singleton FOR UPDATE;
  IF NOT install.complete THEN
    FOR source IN SELECT * FROM access.resource_role_grant
      WHERE erasure_key > install.after_key AND erasure_key <= install.cut
      ORDER BY erasure_key LIMIT 100 FOR UPDATE
    LOOP
      PERFORM access.index_current_resource_role(source);
      install.after_key := source.erasure_key;
      touched := touched+1;
    END LOOP;
    UPDATE access.current_resource_role_install SET after_key=install.after_key,
      complete=(touched < 100 OR install.after_key=install.cut) WHERE singleton;
    RETURN touched;
  END IF;
  -- Each iteration removes one exact due reference. The index supplies its next start key.
  FOR counter IN 1..100 LOOP
    SELECT * INTO item FROM access.current_resource_role_due WHERE due_at <= p_at
      ORDER BY due_at,route,resource_id,interval_key LIMIT 1;
    EXIT WHEN NOT FOUND;
    SELECT processed_at INTO STRICT anchor FROM access.current_resource_role_frontier
      WHERE route=item.route AND resource_id=item.resource_id FOR UPDATE;
    -- A concurrent source writer may have removed/replaced this boundary before the frontier lock.
    DELETE FROM access.current_resource_role_due WHERE route=item.route AND resource_id=item.resource_id
      AND due_at=item.due_at AND interval_key=item.interval_key;
    IF NOT FOUND THEN CONTINUE; END IF;
    anchor := greatest(anchor,item.due_at);
    DELETE FROM access.current_resource_role_key WHERE route=item.route AND interval_key=item.interval_key;
    INSERT INTO access.current_resource_role_key
      SELECT route,resource_id,grant_role,subject_kind,subject_id,subject_role,erasure_key
      FROM access.resource_role_grant WHERE route=item.route AND erasure_key=item.interval_key AND valid @> anchor
      ON CONFLICT DO NOTHING;
    UPDATE access.current_resource_role_frontier SET processed_at=anchor,version=version+1
      WHERE route=item.route AND resource_id=item.resource_id;
    touched := touched+1;
  END LOOP;
  RETURN touched;
END; $$;

-- migrate:down
ALTER TABLE access.current_resource_role_due DROP CONSTRAINT current_resource_role_due_interval_key_fkey,
  ADD CONSTRAINT current_resource_role_due_interval_key_fkey FOREIGN KEY (interval_key)
  REFERENCES access.resource_role_grant (erasure_key) ON DELETE CASCADE;
DROP INDEX access.current_resource_role_due_source;
CREATE INDEX current_resource_role_due_source ON access.current_resource_role_due (interval_key);
ALTER TABLE access.current_resource_role_key DROP CONSTRAINT current_resource_role_key_interval_key_fkey,
  ADD CONSTRAINT current_resource_role_key_interval_key_fkey FOREIGN KEY (interval_key)
  REFERENCES access.resource_role_grant (erasure_key) ON DELETE CASCADE;
DROP INDEX access.current_resource_role_key_source;
CREATE INDEX current_resource_role_key_source ON access.current_resource_role_key (interval_key);
ALTER TABLE access.resource_role_grant DROP CONSTRAINT IF EXISTS resource_role_grant_route_interval;
CREATE OR REPLACE FUNCTION access.index_current_resource_role(source access.resource_role_grant) RETURNS void
    LANGUAGE plpgsql
    AS $$
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
CREATE OR REPLACE FUNCTION access.capture_current_resource_role() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
CREATE OR REPLACE FUNCTION access.advance_current_resource_roles(p_at timestamp with time zone DEFAULT clock_timestamp()) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE install access.current_resource_role_install; source access.resource_role_grant;
  item access.current_resource_role_due; anchor timestamptz; touched integer := 0;
BEGIN
  SELECT * INTO STRICT install FROM access.current_resource_role_install WHERE singleton FOR UPDATE;
  IF NOT install.complete THEN
    FOR source IN SELECT * FROM access.resource_role_grant
      WHERE erasure_key > install.after_key AND erasure_key <= install.cut
      ORDER BY erasure_key LIMIT 100 FOR UPDATE
    LOOP
      PERFORM access.index_current_resource_role(source);
      install.after_key := source.erasure_key;
      touched := touched+1;
    END LOOP;
    UPDATE access.current_resource_role_install SET after_key=install.after_key,
      complete=(touched < 100 OR install.after_key=install.cut) WHERE singleton;
    RETURN touched;
  END IF;
  -- Each iteration removes one exact due reference. The index supplies its next start key.
  FOR counter IN 1..100 LOOP
    SELECT * INTO item FROM access.current_resource_role_due WHERE due_at <= p_at
      ORDER BY due_at,route,resource_id,interval_key LIMIT 1;
    EXIT WHEN NOT FOUND;
    SELECT processed_at INTO STRICT anchor FROM access.current_resource_role_frontier
      WHERE route=item.route AND resource_id=item.resource_id FOR UPDATE;
    -- A concurrent source writer may have removed/replaced this boundary before the frontier lock.
    DELETE FROM access.current_resource_role_due WHERE route=item.route AND resource_id=item.resource_id
      AND due_at=item.due_at AND interval_key=item.interval_key;
    IF NOT FOUND THEN CONTINUE; END IF;
    anchor := greatest(anchor,item.due_at);
    DELETE FROM access.current_resource_role_key WHERE interval_key=item.interval_key;
    INSERT INTO access.current_resource_role_key
      SELECT route,resource_id,grant_role,subject_kind,subject_id,subject_role,erasure_key
      FROM access.resource_role_grant WHERE erasure_key=item.interval_key AND valid @> anchor
      ON CONFLICT DO NOTHING;
    UPDATE access.current_resource_role_frontier SET processed_at=anchor,version=version+1
      WHERE route=item.route AND resource_id=item.resource_id;
    touched := touched+1;
  END LOOP;
  RETURN touched;
END; $$;
