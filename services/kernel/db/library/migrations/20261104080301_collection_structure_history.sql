-- migrate:up
CREATE TABLE library.collection_structure_history_head (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  next_change_no bigint NOT NULL DEFAULT 0,
  unknown_before_tracking boolean NOT NULL,
  has_pruned_gaps boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, collection_id),
  FOREIGN KEY (route, collection_id)
    REFERENCES library.collection (route, collection_id) ON DELETE CASCADE,
  CHECK (next_change_no >= 0)
);

CREATE TABLE library.collection_structure_history (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  change_no bigint NOT NULL,
  change_id uuid NOT NULL DEFAULT gen_random_uuid(),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  transaction_id uuid NOT NULL,
  change_kind text NOT NULL,
  member_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  member_revision bigint NOT NULL,
  before_state jsonb,
  after_state jsonb,
  PRIMARY KEY (route, collection_id, change_no),
  UNIQUE (route, collection_id, change_id),
  FOREIGN KEY (route, collection_id)
    REFERENCES library.collection_structure_history_head (route, collection_id) ON DELETE CASCADE,
  CHECK (change_no >= 1),
  CHECK (member_revision >= 1),
  CHECK (change_kind IN ('added', 'note_changed', 'moved', 'deleted', 'restored', 'transferred_in', 'transferred_out')),
  CHECK (octet_length(COALESCE(before_state::text, '') || COALESCE(after_state::text, '')) <= 32768)
);

CREATE INDEX collection_structure_history_member_operation
  ON library.collection_structure_history (route, member_id, recorded_at DESC, transaction_id, collection_id, change_no);

CREATE TABLE library.collection_structure_pending_change (
  transaction_id uuid NOT NULL,
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  member_id uuid NOT NULL,
  before_state jsonb NOT NULL,
  PRIMARY KEY (transaction_id, route, collection_id, member_id),
  CHECK (octet_length(before_state::text) <= 32768)
);

CREATE FUNCTION library.record_collection_structure_change(
  p_route integer,
  p_collection_id uuid,
  p_transaction_id uuid,
  p_change_kind text,
  p_member_id uuid,
  p_subject_id uuid,
  p_member_revision bigint,
  p_before_state jsonb,
  p_after_state jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_change_no bigint;
  v_pruned integer;
BEGIN
  IF octet_length(COALESCE(p_before_state::text, '') || COALESCE(p_after_state::text, '')) > 32768 THEN
    RAISE EXCEPTION 'Collection structure history operand exceeds 32768 bytes' USING ERRCODE = '22001';
  END IF;

  INSERT INTO library.collection_structure_history_head
    (route, collection_id, next_change_no, unknown_before_tracking)
  VALUES (p_route, p_collection_id, 1, true)
  ON CONFLICT (route, collection_id) DO UPDATE
    SET next_change_no = library.collection_structure_history_head.next_change_no + 1
  RETURNING next_change_no INTO v_change_no;

  INSERT INTO library.collection_structure_history
    (route, collection_id, change_no, transaction_id, change_kind, member_id, subject_id,
     member_revision, before_state, after_state)
  VALUES
    (p_route, p_collection_id, v_change_no, p_transaction_id, p_change_kind, p_member_id, p_subject_id,
     p_member_revision, p_before_state, p_after_state);

  DELETE FROM library.collection_structure_history
  WHERE route = p_route AND collection_id = p_collection_id AND change_no <= v_change_no - 1000;
  GET DIAGNOSTICS v_pruned = ROW_COUNT;
  IF v_pruned > 0 THEN
    UPDATE library.collection_structure_history_head
       SET has_pruned_gaps = true
     WHERE route = p_route AND collection_id = p_collection_id;
  END IF;

  WITH retained_operations AS (
    SELECT transaction_id
      FROM library.collection_structure_history
     WHERE route = p_route AND member_id = p_member_id
     GROUP BY transaction_id
     ORDER BY max(recorded_at) DESC, transaction_id DESC
     LIMIT 16
  ), deleted AS (
    DELETE FROM library.collection_structure_history AS history
     WHERE history.route = p_route AND history.member_id = p_member_id
       AND NOT EXISTS (
         SELECT 1 FROM retained_operations AS retained
          WHERE retained.transaction_id = history.transaction_id
       )
     RETURNING history.route, history.collection_id
  )
  UPDATE library.collection_structure_history_head AS head
     SET has_pruned_gaps = true
   WHERE (head.route, head.collection_id) IN (
     SELECT DISTINCT route, collection_id FROM deleted
   );
END;
$$;

CREATE FUNCTION library.initialize_collection_structure_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.membership_kind = 'curated' AND NEW.curator_account_id IS NOT NULL THEN
    INSERT INTO library.collection_structure_history_head
      (route, collection_id, next_change_no, unknown_before_tracking)
    VALUES (NEW.route, NEW.collection_id, 0, false)
    ON CONFLICT (route, collection_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_structure_history_initialize
  AFTER INSERT ON library.collection
  FOR EACH ROW EXECUTE FUNCTION library.initialize_collection_structure_history();

CREATE FUNCTION library.erase_collection_structure_history_on_curator_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.curator_account_id IS DISTINCT FROM NEW.curator_account_id THEN
    DELETE FROM library.collection_structure_history_head
     WHERE route = NEW.route AND collection_id = NEW.collection_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_structure_history_curator_cleanup
  AFTER UPDATE OF curator_account_id ON library.collection
  FOR EACH ROW EXECUTE FUNCTION library.erase_collection_structure_history_on_curator_change();

CREATE FUNCTION library.collection_structure_position(
  p_route integer,
  p_collection_id uuid,
  p_member_id uuid,
  p_ordinal_key text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_before uuid;
  v_after uuid;
BEGIN
  SELECT
    (SELECT member.member_id
       FROM library.collection_member AS member
      WHERE member.route = p_route AND member.collection_id = p_collection_id
        AND member.deletion_id IS NULL AND member.member_id <> p_member_id
        AND member.ordinal_key < p_ordinal_key
      ORDER BY member.ordinal_key DESC, member.member_id DESC
      LIMIT 1),
    (SELECT member.member_id
       FROM library.collection_member AS member
      WHERE member.route = p_route AND member.collection_id = p_collection_id
        AND member.deletion_id IS NULL AND member.member_id <> p_member_id
        AND member.ordinal_key > p_ordinal_key
      ORDER BY member.ordinal_key, member.member_id
      LIMIT 1)
  INTO v_before, v_after;
  RETURN jsonb_build_object(
    'state', 'known',
    'beforeMemberId', v_before,
    'afterMemberId', v_after
  );
END;
$$;

CREATE FUNCTION library.collection_structure_member_state(
  p_route integer,
  p_collection_id uuid,
  p_member_id uuid,
  p_subject_id uuid,
  p_member_revision bigint,
  p_note text,
  p_added_at timestamptz,
  p_deletion_id uuid,
  p_deleted_at timestamptz,
  p_ordinal_key text,
  p_deleted_ordinal_key text,
  p_context_available boolean
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_placement jsonb;
BEGIN
  IF p_context_available AND p_deletion_id IS NULL THEN
    v_placement := library.collection_structure_position(p_route, p_collection_id, p_member_id, p_ordinal_key);
  ELSIF p_context_available AND p_deletion_id IS NOT NULL AND p_deleted_ordinal_key IS NOT NULL THEN
    v_placement := library.collection_structure_position(p_route, p_collection_id, p_member_id, p_deleted_ordinal_key);
  ELSE
    v_placement := jsonb_build_object('state', 'unavailable');
  END IF;

  RETURN jsonb_build_object(
    'presence', CASE WHEN p_deletion_id IS NULL THEN 'live' ELSE 'deleted' END,
    'memberRevision', p_member_revision::text,
    'note', p_note,
    'addedAt', p_added_at,
    'deletionId', p_deletion_id,
    'deletedAt', p_deleted_at,
    'placement', v_placement
  );
END;
$$;

CREATE FUNCTION library.capture_collection_structure_before_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_curated boolean;
  v_move_member text;
  v_before jsonb;
BEGIN
  IF OLD.deletion_id IS NOT NULL AND NEW.deletion_id IS NOT NULL
     AND NEW.note IS NULL AND NEW.added_at IS NULL AND NEW.deleted_at IS NULL
     AND NEW.deleted_ordinal_key IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.collection_id = NEW.collection_id
     AND OLD.note IS NOT DISTINCT FROM NEW.note
     AND OLD.deletion_id IS NOT DISTINCT FROM NEW.deletion_id
     AND OLD.ordinal_key IS NOT DISTINCT FROM NEW.ordinal_key THEN
    RETURN NEW;
  END IF;

  IF OLD.collection_id = NEW.collection_id
     AND OLD.note IS NOT DISTINCT FROM NEW.note
     AND OLD.deletion_id IS NOT DISTINCT FROM NEW.deletion_id
     AND OLD.ordinal_key IS DISTINCT FROM NEW.ordinal_key THEN
    v_move_member := current_setting('library.collection_structure_move_member', true);
    IF v_move_member IS DISTINCT FROM NEW.member_id::text THEN RETURN NEW; END IF;
  END IF;

  SELECT collection.membership_kind = 'curated' AND collection.curator_account_id IS NOT NULL
    INTO v_curated
    FROM library.collection AS collection
   WHERE collection.route = OLD.route AND collection.collection_id = OLD.collection_id;
  IF NOT COALESCE(v_curated, false) THEN RETURN NEW; END IF;

  v_before := library.collection_structure_member_state(
    OLD.route, OLD.collection_id, OLD.member_id, OLD.subject_id, OLD.member_revision, OLD.note,
    OLD.added_at, OLD.deletion_id, OLD.deleted_at, OLD.ordinal_key, OLD.deleted_ordinal_key,
    OLD.deletion_id IS NULL
  );
  INSERT INTO library.collection_structure_pending_change
    (transaction_id, route, collection_id, member_id, before_state)
  VALUES (NEW.transaction_id, OLD.route, OLD.collection_id, OLD.member_id, v_before)
  ON CONFLICT (transaction_id, route, collection_id, member_id)
  DO UPDATE SET before_state = EXCLUDED.before_state;
  RETURN NEW;
END;
$$;

CREATE FUNCTION library.capture_collection_structure_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
  v_curated boolean;
  v_before jsonb;
  v_after jsonb;
  v_move_member text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.deletion_id IS NOT NULL AND NEW.deletion_id IS NOT NULL
     AND NEW.note IS NULL AND NEW.added_at IS NULL AND NEW.deleted_at IS NULL
     AND NEW.deleted_ordinal_key IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.collection_id = NEW.collection_id
     AND OLD.note IS NOT DISTINCT FROM NEW.note
     AND OLD.deletion_id IS NOT DISTINCT FROM NEW.deletion_id
     AND OLD.ordinal_key IS NOT DISTINCT FROM NEW.ordinal_key THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    DELETE FROM library.collection_structure_pending_change
     WHERE transaction_id = NEW.transaction_id AND route = OLD.route
       AND collection_id = OLD.collection_id AND member_id = OLD.member_id
    RETURNING before_state INTO v_before;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT collection.membership_kind = 'curated' AND collection.curator_account_id IS NOT NULL
      INTO v_curated
      FROM library.collection AS collection
     WHERE collection.route = NEW.route AND collection.collection_id = NEW.collection_id;
    IF NOT COALESCE(v_curated, false) THEN RETURN NEW; END IF;
    v_kind := 'added';
    v_after := library.collection_structure_member_state(
      NEW.route, NEW.collection_id, NEW.member_id, NEW.subject_id, NEW.member_revision, NEW.note,
      NEW.added_at, NEW.deletion_id, NEW.deleted_at, NEW.ordinal_key, NEW.deleted_ordinal_key, true
    );
    PERFORM library.record_collection_structure_change(
      NEW.route, NEW.collection_id, NEW.transaction_id, v_kind, NEW.member_id, NEW.subject_id,
      NEW.member_revision, NULL, v_after
    );
    RETURN NEW;
  END IF;

  IF OLD.collection_id IS DISTINCT FROM NEW.collection_id THEN
    SELECT collection.membership_kind = 'curated' AND collection.curator_account_id IS NOT NULL
      INTO v_curated
      FROM library.collection AS collection
     WHERE collection.route = OLD.route AND collection.collection_id = OLD.collection_id;
    IF COALESCE(v_curated, false) AND OLD.deletion_id IS NULL THEN
      IF v_before IS NULL THEN RAISE EXCEPTION 'Collection structure prior state was not captured'; END IF;
      v_after := jsonb_build_object(
        'presence', 'not_in_collection',
        'memberRevision', NEW.member_revision::text,
        'note', NULL,
        'addedAt', NULL,
        'deletedAt', NULL,
        'placement', v_before->'placement'
      );
      PERFORM library.record_collection_structure_change(
        OLD.route, OLD.collection_id, NEW.transaction_id, 'transferred_out', OLD.member_id, OLD.subject_id,
        NEW.member_revision, v_before, v_after
      );
    END IF;

    SELECT collection.membership_kind = 'curated' AND collection.curator_account_id IS NOT NULL
      INTO v_curated
      FROM library.collection AS collection
     WHERE collection.route = NEW.route AND collection.collection_id = NEW.collection_id;
    IF COALESCE(v_curated, false) AND NEW.deletion_id IS NULL THEN
      v_after := library.collection_structure_member_state(
        NEW.route, NEW.collection_id, NEW.member_id, NEW.subject_id, NEW.member_revision, NEW.note,
        NEW.added_at, NEW.deletion_id, NEW.deleted_at, NEW.ordinal_key, NEW.deleted_ordinal_key, true
      );
      PERFORM library.record_collection_structure_change(
        NEW.route, NEW.collection_id, NEW.transaction_id, 'transferred_in', NEW.member_id, NEW.subject_id,
        NEW.member_revision, NULL, v_after
      );
    END IF;
    RETURN NEW;
  END IF;

  SELECT collection.membership_kind = 'curated' AND collection.curator_account_id IS NOT NULL
    INTO v_curated
    FROM library.collection AS collection
   WHERE collection.route = NEW.route AND collection.collection_id = NEW.collection_id;
  IF NOT COALESCE(v_curated, false) THEN RETURN NEW; END IF;

  IF OLD.deletion_id IS NULL AND NEW.deletion_id IS NOT NULL THEN
    v_kind := 'deleted';
  ELSIF OLD.deletion_id IS NOT NULL AND NEW.deletion_id IS NULL THEN
    v_kind := 'restored';
  ELSIF OLD.deletion_id IS NULL AND NEW.deletion_id IS NULL AND OLD.note IS DISTINCT FROM NEW.note THEN
    v_kind := 'note_changed';
  ELSIF OLD.deletion_id IS NULL AND NEW.deletion_id IS NULL AND OLD.ordinal_key IS DISTINCT FROM NEW.ordinal_key THEN
    v_move_member := current_setting('library.collection_structure_move_member', true);
    IF v_move_member IS DISTINCT FROM NEW.member_id::text THEN RETURN NEW; END IF;
    v_kind := 'moved';
  ELSE
    RETURN NEW;
  END IF;

  IF v_before IS NULL THEN RAISE EXCEPTION 'Collection structure prior state was not captured'; END IF;
  v_after := library.collection_structure_member_state(
    NEW.route, NEW.collection_id, NEW.member_id, NEW.subject_id, NEW.member_revision, NEW.note,
    NEW.added_at, NEW.deletion_id, NEW.deleted_at, NEW.ordinal_key, NEW.deleted_ordinal_key,
    NEW.deletion_id IS NULL OR v_kind = 'deleted'
  );
  PERFORM library.record_collection_structure_change(
    NEW.route, NEW.collection_id, NEW.transaction_id, v_kind, NEW.member_id, NEW.subject_id,
    NEW.member_revision, v_before, v_after
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_member_structure_history_before
  BEFORE UPDATE OF collection_id, note, ordinal_key, deletion_id ON library.collection_member
  FOR EACH ROW EXECUTE FUNCTION library.capture_collection_structure_before_change();

CREATE TRIGGER collection_member_structure_history
  AFTER INSERT OR UPDATE OF collection_id, note, ordinal_key, deletion_id ON library.collection_member
  FOR EACH ROW EXECUTE FUNCTION library.capture_collection_structure_change();

CREATE FUNCTION library.erase_collection_structure_member_history_values(
  p_route integer,
  p_member_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_deleted_collections record;
BEGIN
  FOR v_deleted_collections IN
    WITH deleted AS (
      DELETE FROM library.collection_structure_history
       WHERE route = p_route AND member_id = p_member_id
       RETURNING route, collection_id
    )
    SELECT DISTINCT route, collection_id FROM deleted
  LOOP
    UPDATE library.collection_structure_history_head
       SET has_pruned_gaps = true
     WHERE route = v_deleted_collections.route AND collection_id = v_deleted_collections.collection_id;
  END LOOP;
END;
$$;

CREATE FUNCTION library.erase_collection_structure_member_history_on_minimize() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deletion_id IS NOT NULL AND NEW.deletion_id IS NOT NULL
     AND NEW.note IS NULL AND NEW.added_at IS NULL AND NEW.deleted_at IS NULL
     AND NEW.deleted_ordinal_key IS NULL
     AND (OLD.note IS DISTINCT FROM NEW.note OR OLD.added_at IS DISTINCT FROM NEW.added_at
       OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
       OR OLD.deleted_ordinal_key IS DISTINCT FROM NEW.deleted_ordinal_key) THEN
    PERFORM library.erase_collection_structure_member_history_values(OLD.route, OLD.member_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_member_structure_history_retention_cleanup
  AFTER UPDATE OF note, added_at, deleted_at, deleted_ordinal_key ON library.collection_member
  FOR EACH ROW EXECUTE FUNCTION library.erase_collection_structure_member_history_on_minimize();

CREATE FUNCTION library.erase_collection_structure_member_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM library.erase_collection_structure_member_history_values(OLD.route, OLD.member_id);
  RETURN OLD;
END;
$$;

CREATE TRIGGER collection_member_structure_history_cleanup
  AFTER DELETE ON library.collection_member
  FOR EACH ROW EXECUTE FUNCTION library.erase_collection_structure_member_history();

-- migrate:down
DROP TRIGGER collection_member_structure_history_cleanup ON library.collection_member;
DROP FUNCTION library.erase_collection_structure_member_history();
DROP TRIGGER collection_member_structure_history_retention_cleanup ON library.collection_member;
DROP FUNCTION library.erase_collection_structure_member_history_on_minimize();
DROP FUNCTION library.erase_collection_structure_member_history_values(integer, uuid);
DROP TRIGGER collection_member_structure_history ON library.collection_member;
DROP TRIGGER collection_member_structure_history_before ON library.collection_member;
DROP FUNCTION library.capture_collection_structure_change();
DROP FUNCTION library.capture_collection_structure_before_change();
DROP FUNCTION library.collection_structure_member_state(integer, uuid, uuid, uuid, bigint, text, timestamptz, uuid, timestamptz, text, text, boolean);
DROP FUNCTION library.collection_structure_position(integer, uuid, uuid, text);
DROP TRIGGER collection_structure_history_curator_cleanup ON library.collection;
DROP FUNCTION library.erase_collection_structure_history_on_curator_change();
DROP TRIGGER collection_structure_history_initialize ON library.collection;
DROP FUNCTION library.initialize_collection_structure_history();
DROP FUNCTION library.record_collection_structure_change(integer, uuid, uuid, text, uuid, uuid, bigint, jsonb, jsonb);
DROP TABLE library.collection_structure_pending_change;
DROP TABLE library.collection_structure_history;
DROP TABLE library.collection_structure_history_head;
