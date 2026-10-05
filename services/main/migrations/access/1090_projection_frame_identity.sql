-- An ordered membership index over the immutable identity rows' frames. Array GIN
-- finds members but must sort every match before LIMIT; these two B-trees seek
-- directly to a bounded page, including when the subject is also selected.
CREATE TABLE access.projection_frame_identity (
  frame text NOT NULL,
  projection uuid NOT NULL REFERENCES access.projection_identity(projection),
  subject text NOT NULL,
  PRIMARY KEY (frame, projection)
);
CREATE INDEX projection_frame_identity_subject
  ON access.projection_frame_identity (frame, subject, projection);

CREATE FUNCTION access.check_projection_frame_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM access.projection_identity
    WHERE projection = NEW.projection AND subject = NEW.subject AND NEW.frame = ANY(frames)) THEN
    RAISE EXCEPTION 'Projection frame membership must match its identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER projection_frame_identity_matches BEFORE INSERT
  ON access.projection_frame_identity FOR EACH ROW
  EXECUTE FUNCTION access.check_projection_frame_identity();
CREATE TRIGGER projection_frame_identity_immutable BEFORE UPDATE OR DELETE
  ON access.projection_frame_identity FOR EACH ROW
  EXECUTE FUNCTION access.reject_projection_identity_mutation();

CREATE FUNCTION access.index_projection_frames() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO access.projection_frame_identity (frame, projection, subject)
    SELECT DISTINCT frame, NEW.projection, NEW.subject FROM unnest(NEW.frames) AS frame;
  RETURN NEW;
END $$;
CREATE TRIGGER projection_identity_frames AFTER INSERT
  ON access.projection_identity FOR EACH ROW
  EXECUTE FUNCTION access.index_projection_frames();

-- Also index identities reserved before this migration, including interrupted commands.
INSERT INTO access.projection_frame_identity (frame, projection, subject)
  SELECT DISTINCT frame, projection, subject FROM access.projection_identity, unnest(frames) AS frame;
