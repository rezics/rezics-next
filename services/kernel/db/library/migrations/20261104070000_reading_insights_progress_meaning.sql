-- migrate:up
-- Preserve the accepting descriptor used by each new native progress session.
-- Existing sessions intentionally remain without a snapshot and therefore unavailable.
CREATE TABLE library.reading_insights_progress_meaning (
  route integer NOT NULL,
  session_id uuid NOT NULL,
  unit_id text COLLATE "C" NOT NULL CHECK (char_length(unit_id) BETWEEN 1 AND 128),
  meaning_revision smallint NOT NULL CHECK (meaning_revision = 1),
  mode text NOT NULL CHECK (mode IN ('scalar_amount','cursor_position','completed_units')),
  profile_pin jsonb NOT NULL CHECK (jsonb_typeof(profile_pin) = 'object'),
  dimension text,
  precision smallint CHECK (precision BETWEEN 0 AND 6),
  minimum numeric,
  maximum numeric,
  total_policy text CHECK (total_policy IS NULL OR total_policy IN ('optional','required','forbidden')),
  identity_kind text NOT NULL CHECK (identity_kind IN ('none','session_local')),
  structure_kind text NOT NULL CHECK (structure_kind = 'none'),
  PRIMARY KEY (route,session_id,unit_id)
);
CREATE FUNCTION library.reading_insights_progress_meaning_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM library.reading_insights_progress_meaning WHERE route=OLD.route AND session_id=OLD.session_id;
  RETURN OLD;
END $$;
CREATE TRIGGER reading_insights_progress_meaning_delete AFTER DELETE ON library.progress_session
  FOR EACH ROW EXECUTE FUNCTION library.reading_insights_progress_meaning_delete();
CREATE FUNCTION library.reading_insights_progress_meaning_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  TRUNCATE library.reading_insights_progress_meaning;
  RETURN NULL;
END $$;
CREATE TRIGGER reading_insights_progress_meaning_truncate AFTER TRUNCATE ON library.progress_session
  FOR EACH STATEMENT EXECUTE FUNCTION library.reading_insights_progress_meaning_truncate();

-- migrate:down
-- Forward only: retained descriptor meaning belongs to its original session.
