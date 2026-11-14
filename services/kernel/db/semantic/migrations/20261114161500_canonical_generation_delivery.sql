-- migrate:up
-- Keep delivery on the native, retained home inventory. A notification is not coverage:
-- only the receiving owner's completed rebuild permits this watermark to advance.
ALTER TABLE semantic.partition_subjects
  ADD COLUMN canonical_delivered_generation bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT partition_subjects_canonical_delivery_check
    CHECK (canonical_delivered_generation BETWEEN 0 AND canonical_generation);
CREATE INDEX partition_subjects_canonical_delivery ON semantic.partition_subjects(partition_no)
  WHERE canonical_delivered_generation<canonical_generation;

-- The Subject/name triggers already capture creation, name selection, visibility and removal.
-- Redirect and native mapping transitions must invalidate both original and terminal homes,
-- even when no Subject row changed. This uses keyed identity reads, not an inverse fanout.
CREATE FUNCTION semantic.capture_canonical_identity_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  originals uuid[] := ARRAY[]::uuid[];
  controls integer[] := ARRAY[]::integer[];
  previous_target uuid;
  home integer;
BEGIN
  IF TG_TABLE_NAME='redirect' THEN
    IF TG_OP<>'INSERT' THEN
      originals := originals || ARRAY[OLD.subject_id,OLD.target];
      -- After deletion/update, the newly selected redirect can restore another terminal.
      SELECT target INTO previous_target FROM semantic.redirect
        WHERE route=OLD.route AND subject_id=OLD.subject_id ORDER BY sequence DESC LIMIT 1;
      originals := array_append(originals,previous_target);
    END IF;
    IF TG_OP<>'DELETE' THEN
      originals := originals || ARRAY[NEW.subject_id,NEW.target];
      -- An INSERT has no OLD row: retain the superseded selected target explicitly.
      SELECT target INTO previous_target FROM semantic.redirect
        WHERE route=NEW.route AND subject_id=NEW.subject_id AND sequence<>NEW.sequence
        ORDER BY sequence DESC LIMIT 1;
      originals := array_append(originals,previous_target);
    END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN
      originals := originals || ARRAY[OLD.original,OLD.terminal];
      controls := array_append(controls,OLD.control_partition);
    END IF;
    IF TG_OP<>'DELETE' THEN
      originals := originals || ARRAY[NEW.original,NEW.terminal];
      controls := array_append(controls,NEW.control_partition);
    END IF;
  END IF;
  -- At most six distinct originals, six keyed terminal lookups and two control homes.
  -- Sorting makes the added home-row locks deterministic. Native command contention retries
  -- retain the original mutation's atomicity; neither generation nor delivery escapes rollback.
  FOR home IN
    WITH ids AS (SELECT DISTINCT id FROM unnest(originals) AS input(id) WHERE id IS NOT NULL),
    affected AS (
      SELECT id FROM ids
      UNION
      SELECT mapping.terminal FROM ids
      JOIN semantic.identity_epoch_mapping AS mapping
        ON mapping.route=get_byte(uuid_send(ids.id),10)*256+get_byte(uuid_send(ids.id),11)
       AND mapping.original=ids.id
    )
    SELECT (get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11))/16 FROM affected
    UNION SELECT value FROM unnest(controls) AS input(value) WHERE value IS NOT NULL
    ORDER BY 1
  LOOP
    INSERT INTO semantic.partition_subjects(partition_no,canonical_generation) VALUES(home,1)
      ON CONFLICT(partition_no) DO UPDATE
      SET canonical_generation=partition_subjects.canonical_generation+1;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER redirect_canonical_generation AFTER INSERT OR UPDATE OR DELETE ON semantic.redirect
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_canonical_identity_generation();
CREATE TRIGGER identity_mapping_canonical_generation AFTER INSERT OR UPDATE OR DELETE ON semantic.identity_epoch_mapping
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_canonical_identity_generation();

-- migrate:down
-- Forward only: retained empty homes and acknowledged generations cannot be discarded safely.
SELECT 1;
