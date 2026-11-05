-- migrate:up
-- Empty source homes have no candidate window to inspect. Settle their fixed
-- bootstrap metadata once, and reopen a home if it later gains its first row.
UPDATE semantic.subject_page_bootstrap AS bootstrap
SET state='done', worker=NULL, lease_until=NULL, available_at=now()
WHERE bootstrap.state='pending'
  AND NOT EXISTS (
    SELECT 1 FROM semantic.partition_subjects AS subjects
    WHERE subjects.partition_no=bootstrap.partition_no AND subjects.visible>0
  );

CREATE FUNCTION semantic.subject_page_bootstrap_population() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.visible>0 AND (TG_OP='INSERT' OR OLD.visible=0) THEN
    UPDATE semantic.subject_page_bootstrap
    SET version=version+1, source_key=NULL, state='pending', available_at=now(), worker=NULL, lease_until=NULL
    WHERE partition_no=NEW.partition_no AND state='done';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER subject_page_bootstrap_population
AFTER INSERT OR UPDATE OF visible ON semantic.partition_subjects
FOR EACH ROW EXECUTE FUNCTION semantic.subject_page_bootstrap_population();

-- migrate:down
DROP TRIGGER subject_page_bootstrap_population ON semantic.partition_subjects;
DROP FUNCTION semantic.subject_page_bootstrap_population();
