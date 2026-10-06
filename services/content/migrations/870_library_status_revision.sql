-- Existing libraries start at revision zero without scanning or rewriting their
-- inventory. The first subsequent mutation atomically creates their revision.
-- Separate sort revisions preserve cursors when unrelated private metadata moves.
CREATE TABLE reader.library_status_revision (
  agent text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0,
  title_revision bigint NOT NULL DEFAULT 0,
  rating_revision bigint NOT NULL DEFAULT 0,
  progress_revision bigint NOT NULL DEFAULT 0
);

CREATE FUNCTION reader.advance_library_status_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  membership integer := 0;
  title integer := 0;
  rating integer := 0;
  progress integer := 0;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    membership := 1;
  ELSE
    membership := ((NEW.agent, NEW.work, NEW.status, NEW.version, NEW.changed_at, NEW.started_on, NEW.finished_on)
      IS DISTINCT FROM (OLD.agent, OLD.work, OLD.status, OLD.version, OLD.changed_at, OLD.started_on, OLD.finished_on))::integer;
    title := (NEW.title_key IS DISTINCT FROM OLD.title_key)::integer;
    rating := (NEW.own_rating IS DISTINCT FROM OLD.own_rating)::integer;
    progress := (NEW.last_read_at IS DISTINCT FROM OLD.last_read_at)::integer;
  END IF;
  IF membership + title + rating + progress = 0 THEN RETURN NULL; END IF;
  -- An identity transfer invalidates the departing person's cursor as well.
  IF TG_OP = 'UPDATE' AND NEW.agent IS DISTINCT FROM OLD.agent THEN
    INSERT INTO reader.library_status_revision(agent, revision) VALUES (OLD.agent, 1)
    ON CONFLICT (agent) DO UPDATE SET revision = reader.library_status_revision.revision + 1;
    membership := 1;
  END IF;
  INSERT INTO reader.library_status_revision(agent, revision, title_revision, rating_revision, progress_revision)
    VALUES (COALESCE(NEW.agent, OLD.agent), membership, title, rating, progress)
  ON CONFLICT (agent) DO UPDATE SET revision = reader.library_status_revision.revision + membership,
    title_revision = reader.library_status_revision.title_revision + title,
    rating_revision = reader.library_status_revision.rating_revision + rating,
    progress_revision = reader.library_status_revision.progress_revision + progress;
  RETURN NULL;
END $$;
CREATE TRIGGER library_status_revision AFTER INSERT OR UPDATE OR DELETE ON reader.library_status
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_status_revision();
