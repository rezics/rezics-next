-- migrate:up
-- Current publication heads are the complete native Realm membership population.
-- A retained reader must notice replacement/withdrawal even when the Realm revision is unchanged.
ALTER TABLE community.realm ADD COLUMN publication_generation bigint NOT NULL DEFAULT 0
  CHECK (publication_generation >= 0);

CREATE INDEX publication_head_adopted_subject
  ON community.publication_head (route, realm_id, subject_id)
  WHERE verdict = 'adopt';

CREATE FUNCTION community.advance_publication_population() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE community.realm SET publication_generation = publication_generation + 1
    WHERE route = COALESCE(NEW.route, OLD.route)
      AND realm_id = COALESCE(NEW.realm_id, OLD.realm_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER publication_population AFTER INSERT OR UPDATE OR DELETE ON community.publication_head
FOR EACH ROW EXECUTE FUNCTION community.advance_publication_population();

-- migrate:down
