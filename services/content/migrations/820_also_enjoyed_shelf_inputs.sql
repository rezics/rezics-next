-- A co-reader build reads only 'read' and 'reading' shelves. A change whose old
-- and new rows both lie outside them, such as adding or dropping want-to-read,
-- is not its input and appends no change row. Migration 800 is otherwise unchanged.
CREATE OR REPLACE FUNCTION reader.advance_also_enjoyed_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.agent, NEW.work, NEW.status)
    IS NOT DISTINCT FROM (OLD.agent, OLD.work, OLD.status) THEN RETURN NULL; END IF;
  IF TG_OP <> 'TRUNCATE' AND coalesce(to_jsonb(OLD)->>'status', '') NOT IN ('read', 'reading')
    AND coalesce(to_jsonb(NEW)->>'status', '') NOT IN ('read', 'reading') THEN RETURN NULL; END IF;
  PERFORM reader.record_also_enjoyed_source_change();
  RETURN NULL;
END $$;
