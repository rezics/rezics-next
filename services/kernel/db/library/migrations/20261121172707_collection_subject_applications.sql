-- migrate:up
CREATE TABLE library.collection_member_application (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  member_id uuid NOT NULL,
  applied_subject_id uuid NOT NULL,
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 32),
  live_ordinal text COLLATE "C",
  PRIMARY KEY (route, collection_id, member_id, applied_subject_id),
  UNIQUE (route, collection_id, member_id, slot),
  FOREIGN KEY (route, collection_id, member_id)
    REFERENCES library.collection_member (route, collection_id, member_id) ON DELETE CASCADE
);

CREATE INDEX collection_member_application_order
  ON library.collection_member_application (route, collection_id, applied_subject_id, live_ordinal, member_id)
  WHERE live_ordinal IS NOT NULL;

CREATE FUNCTION library.refresh_collection_member_application_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE library.collection_member_application
  SET live_ordinal = CASE WHEN NEW.deletion_id IS NULL THEN NEW.ordinal_key END
  WHERE route = NEW.route AND collection_id = NEW.collection_id AND member_id = NEW.member_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_member_application_order
AFTER UPDATE OF ordinal_key, deletion_id ON library.collection_member
FOR EACH ROW WHEN (OLD.ordinal_key IS DISTINCT FROM NEW.ordinal_key OR OLD.deletion_id IS DISTINCT FROM NEW.deletion_id)
EXECUTE FUNCTION library.refresh_collection_member_application_order();

-- migrate:down
DROP TRIGGER collection_member_application_order ON library.collection_member;
DROP FUNCTION library.refresh_collection_member_application_order();
DROP TABLE library.collection_member_application;
