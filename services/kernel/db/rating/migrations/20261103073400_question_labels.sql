-- migrate:up
-- Presentation is separate from the immutable measurement and creation wording.
CREATE TABLE rating.question_label_head (
  question_id uuid PRIMARY KEY REFERENCES rating.question(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200 AND length(btrim(label)) > 0)
);
CREATE TABLE rating.question_label_revision (
  question_id uuid NOT NULL REFERENCES rating.question(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 2),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200 AND length(btrim(label)) > 0),
  author_id uuid NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (question_id, revision)
);
CREATE FUNCTION rating.keep_question_label_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Question caption revisions are immutable';
END;
$$;
CREATE TRIGGER question_label_revision_immutable BEFORE UPDATE ON rating.question_label_revision
FOR EACH ROW EXECUTE FUNCTION rating.keep_question_label_revision();
CREATE FUNCTION rating.initialize_question_label() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.realm_id IS NOT NULL THEN
    INSERT INTO rating.question_label_head (question_id, revision, label) VALUES (NEW.id, 1, NEW.label);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER question_label_initial AFTER INSERT ON rating.question
FOR EACH ROW EXECUTE FUNCTION rating.initialize_question_label();
INSERT INTO rating.question_label_head (question_id, revision, label)
SELECT id, 1, label FROM rating.question WHERE realm_id IS NOT NULL;

-- migrate:down
-- Forward only: retained exact caption references must keep their original bytes.
