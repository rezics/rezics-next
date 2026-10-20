-- Source owns a position for each selected field's support inventory. Query
-- continuations seal it with their existing native/disclosure/read-session basis.
-- Only writes to the same field share a counter row; unrelated Works and fields
-- never acquire a global serialization point. The counter commits atomically
-- with settlement/withdrawal, including changes before a keyset frontier.
CREATE TABLE source.field_support_generation (
  target text NOT NULL,
  slot text NOT NULL,
  occurrence text,
  context text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  UNIQUE NULLS NOT DISTINCT (target, slot, occurrence, context)
);
CREATE FUNCTION source.advance_field_support_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE support source.field_support;
BEGIN
  IF TG_TABLE_NAME = 'field_support_outcome' THEN
    SELECT s.* INTO STRICT support FROM source.field_support s
      JOIN source.field_support_step st ON st.support_id=s.id WHERE st.id=NEW.step_id;
  ELSE
    SELECT s.* INTO STRICT support FROM source.field_support s WHERE s.id=NEW.support_id;
  END IF;
  INSERT INTO source.field_support_generation (target,slot,occurrence,context,generation)
    VALUES (support.target,support.slot,support.occurrence,support.context,1)
    ON CONFLICT (target,slot,occurrence,context)
    DO UPDATE SET generation=source.field_support_generation.generation+1;
  RETURN NULL;
END $$;
CREATE TRIGGER source_field_support_settled_generation AFTER INSERT ON source.field_support_outcome
  FOR EACH ROW EXECUTE FUNCTION source.advance_field_support_generation();
CREATE TRIGGER source_field_support_withdrawn_generation AFTER INSERT ON source.field_support_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.advance_field_support_generation();
