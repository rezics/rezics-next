-- migrate:up
CREATE OR REPLACE FUNCTION semantic.capture_canonical_identity_generation() RETURNS trigger LANGUAGE plpgsql AS $$
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
    -- An inserted self mapping is already its own terminal. The row's route
    -- constraint binds the original UUID to the same home as its control.
    IF TG_OP='INSERT' AND NEW.original=NEW.terminal AND NEW.control_partition=NEW.route/16 THEN
      INSERT INTO semantic.partition_subjects(partition_no,canonical_generation) VALUES(NEW.control_partition,1)
        ON CONFLICT(partition_no) DO UPDATE SET canonical_generation=partition_subjects.canonical_generation+1;
      RETURN NULL;
    END IF;
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

CREATE OR REPLACE FUNCTION semantic.capture_canonical_subject_population() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Updating a Subject within its home used to remove and re-add its count.
  -- Both generation increments remain visible at commit, with one row write.
  IF TG_OP='UPDATE' AND OLD.route/16=NEW.route/16 THEN
    UPDATE semantic.partition_subjects SET canonical_generation=canonical_generation+2
      WHERE partition_no=NEW.route/16 AND canonical_count>0;
    IF FOUND THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE semantic.partition_subjects
      SET canonical_count=canonical_count-1,canonical_generation=canonical_generation+1
      WHERE partition_no=OLD.route/16;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO semantic.partition_subjects(partition_no,canonical_count,canonical_generation)
      VALUES(NEW.route/16,1,1)
      ON CONFLICT(partition_no) DO UPDATE SET canonical_count=partition_subjects.canonical_count+1,
        canonical_generation=partition_subjects.canonical_generation+1;
  END IF;
  RETURN NULL;
END;
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.capture_canonical_identity_generation() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION semantic.capture_canonical_subject_population() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE semantic.partition_subjects
      SET canonical_count=canonical_count-1,canonical_generation=canonical_generation+1
      WHERE partition_no=OLD.route/16;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO semantic.partition_subjects(partition_no,canonical_count,canonical_generation)
      VALUES(NEW.route/16,1,1)
      ON CONFLICT(partition_no) DO UPDATE SET canonical_count=partition_subjects.canonical_count+1,
        canonical_generation=partition_subjects.canonical_generation+1;
  END IF;
  RETURN NULL;
END;
$$;
