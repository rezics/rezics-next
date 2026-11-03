-- migrate:up
-- owner_id remains the creating account; realm_id supplies distinct provenance.
ALTER TABLE rating.question ADD COLUMN realm_id uuid;
ALTER TABLE rating.question ADD COLUMN meaning text;
ALTER TABLE rating.question ADD CONSTRAINT question_realm_definition_check CHECK (
  (realm_id IS NULL AND meaning IS NULL) OR
  (realm_id IS NOT NULL AND owner_id IS NOT NULL AND meaning IS NOT NULL
   AND char_length(btrim(meaning)) BETWEEN 1 AND 2000
   AND char_length(btrim(label)) BETWEEN 1 AND 200
   AND minimum_units >= 0 AND maximum_units <= 20 AND maximum_units > minimum_units
   AND get_byte(uuid_send(id), 10) = get_byte(uuid_send(realm_id), 10)
   AND get_byte(uuid_send(id), 11) = get_byte(uuid_send(realm_id), 11))
);
CREATE INDEX question_realm_directory_idx ON rating.question (realm_id, id);

CREATE FUNCTION rating.keep_question_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.realm_id IS NOT NULL OR NEW.realm_id IS NOT NULL) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Realm question definitions are immutable; create another question';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER question_definition_immutable BEFORE UPDATE ON rating.question
FOR EACH ROW EXECUTE FUNCTION rating.keep_question_definition();

-- migrate:down
-- Forward only: question identities and the meaning of existing votes are retained.
