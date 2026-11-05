-- migrate:up
-- A structural, private version shared by the four native fact drivers. It proves no
-- positive presence, readiness, count, deletion generation or follow coverage.
-- Existing owners without a head remain explicitly unbuilt until bounded native
-- maintenance or an empty proof; there is no backfill or initialization on reads.
-- Each relevant row mutation pays for one fixed owner metadata point in its ordinary
-- command cost. Only trusted owner-key migration can touch a second (old) owner.
CREATE FUNCTION library.advance_fact_source_head() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO library.fact_source_head AS head (route, account_id, generation)
      VALUES (OLD.route, OLD.account_id, 1)
      ON CONFLICT (route, account_id) DO UPDATE SET generation = head.generation + 1;
  ELSE
    INSERT INTO library.fact_source_head AS head (route, account_id, generation)
      VALUES (NEW.route, NEW.account_id, 1)
      ON CONFLICT (route, account_id) DO UPDATE SET generation = head.generation + 1;
    IF TG_OP = 'UPDATE' THEN
      IF (OLD.route, OLD.account_id) IS DISTINCT FROM (NEW.route, NEW.account_id) THEN
        INSERT INTO library.fact_source_head AS head (route, account_id, generation)
          VALUES (OLD.route, OLD.account_id, 1)
          ON CONFLICT (route, account_id) DO UPDATE SET generation = head.generation + 1;
      END IF;
    END IF;
  END IF;
  -- Native bigint overflow aborts the fact mutation and its metadata atomically.
  RETURN NULL;
END;
$$;

CREATE TRIGGER entry_fact_source_rows
  AFTER INSERT OR DELETE ON library.entry
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER entry_fact_source_update
  AFTER UPDATE ON library.entry
  FOR EACH ROW WHEN (
    (OLD.route, OLD.account_id, OLD.subject_id, OLD.state, OLD.library_profile_pin)
      IS DISTINCT FROM
    (NEW.route, NEW.account_id, NEW.subject_id, NEW.state, NEW.library_profile_pin)
  ) EXECUTE FUNCTION library.advance_fact_source_head();

CREATE TRIGGER copy_fact_source_rows
  AFTER INSERT OR DELETE ON library.copy
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER copy_fact_source_update
  AFTER UPDATE ON library.copy
  FOR EACH ROW WHEN (
    (OLD.route, OLD.account_id, OLD.subject_id, OLD.library_profile_pin)
      IS DISTINCT FROM
    (NEW.route, NEW.account_id, NEW.subject_id, NEW.library_profile_pin)
  ) EXECUTE FUNCTION library.advance_fact_source_head();

CREATE TRIGGER progress_session_fact_source_rows
  AFTER INSERT OR DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER progress_session_fact_source_update
  AFTER UPDATE ON library.progress_session
  FOR EACH ROW WHEN (
    (OLD.route, OLD.account_id, OLD.subject_id, OLD.library_profile_pin)
      IS DISTINCT FROM
    (NEW.route, NEW.account_id, NEW.subject_id, NEW.library_profile_pin)
  ) EXECUTE FUNCTION library.advance_fact_source_head();

CREATE TRIGGER label_assignment_fact_source_rows
  AFTER INSERT OR DELETE ON library.label_assignment
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER label_assignment_fact_source_update
  AFTER UPDATE ON library.label_assignment
  FOR EACH ROW WHEN (
    (OLD.route, OLD.account_id, OLD.subject_id, OLD.label_id,
     OLD.assignment_id, OLD.slot_no, OLD.deleted_at) IS DISTINCT FROM
    (NEW.route, NEW.account_id, NEW.subject_id, NEW.label_id,
     NEW.assignment_id, NEW.slot_no, NEW.deleted_at)
  ) EXECUTE FUNCTION library.advance_fact_source_head();

-- Parent liveness changes invalidate one owner point regardless of child count.
-- Creation and rename alone add no fact. Erasure conservatively invalidates it.
CREATE TRIGGER personal_label_fact_source_delete
  AFTER DELETE ON library.personal_label
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER personal_label_fact_source_update
  AFTER UPDATE ON library.personal_label
  FOR EACH ROW WHEN (
    (OLD.route, OLD.account_id, OLD.deleted_at) IS DISTINCT FROM
    (NEW.route, NEW.account_id, NEW.deleted_at)
  ) EXECUTE FUNCTION library.advance_fact_source_head();

-- Raw subject/fact keyset seeks cannot use the chronological subject indexes.
-- Entry's primary key and the reserved assignment source already supply theirs.
CREATE INDEX copy_raw_source
  ON library.copy (route, account_id, subject_id, copy_id);
CREATE INDEX progress_session_raw_source
  ON library.progress_session (route, account_id, subject_id, session_id);

-- This first scope covers Everything/state membership only. Progress amount,
-- locator, units, completion dates and copy notes/location do not advance it.
-- Future query predicates must extend relevant-field coverage before activation.
-- Account-erasure inventory: library.fact_source_head, exact (route, account_id).
-- At terminal account T, purge this point LAST, after all private fact children
-- (including entry, copy, progress_session, label_assignment and personal_label),
-- since their erasure triggers can otherwise recreate it. It grants no restore
-- authority and stores no payload, history, user revision, timestamp or state.

-- migrate:down
-- Forward only: source fences must survive rollback.
