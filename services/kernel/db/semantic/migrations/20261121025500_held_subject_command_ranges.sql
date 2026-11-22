-- migrate:up
-- Older nonzero pages may predate the placement and retention invalidators.
-- Keep their original stamp ineligible until a detailed native comparison.
ALTER TABLE semantic.subject_access_page_v1 ADD COLUMN command_repair_stamp boolean;
ALTER TABLE semantic.subject_access_page_v1 ALTER COLUMN command_repair_stamp SET DEFAULT true;

-- Post-adoption command windows reopen the same placement, privacy and retention
-- stamp even when command history predates the inventory cut.

CREATE FUNCTION semantic.subject_repair_page_current_v1(p semantic.subject_access_page_v1) RETURNS boolean
    LANGUAGE sql STABLE STRICT
    AS $$
  WITH stamp AS MATERIALIZED (
    SELECT semantic.subject_access_range_revisions_v1(p.first_home,p.end_home) AS revisions
    WHERE p.first_home%32=0 AND p.end_home=p.first_home+32
  )
  SELECT EXISTS (SELECT FROM stamp WHERE cardinality(revisions)=1 AND
    (((p.quiet_digest IS NOT NULL OR p.command_repair_stamp IS TRUE) AND p.access_revisions=revisions) OR EXISTS (SELECT FROM semantic.subject_quiet_recheck_v1 q
      WHERE (q.birth,q.first_home,q.revision)=(p.birth,p.first_home,revisions[1]))))
$$;

CREATE OR REPLACE FUNCTION semantic.verify_subject_quiet_recheck_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p semantic.subject_access_page_v1;
BEGIN
  SELECT * INTO STRICT p FROM semantic.subject_access_page_v1 WHERE (birth,first_home)=(NEW.birth,NEW.first_home);
  IF p.first_home%32<>0 OR p.end_home<>p.first_home+32 THEN
    RAISE EXCEPTION 'Missing aligned Subject interval'; END IF;
  SELECT revision INTO STRICT NEW.revision
    FROM unnest(semantic.subject_access_range_revisions_v1(p.first_home,p.end_home)) revision;
  IF semantic.capture_subject_access_page_v1(p.birth,p.first_home,p.end_home) IS DISTINCT FROM p.cuts
    THEN RAISE EXCEPTION 'Subject interval changed'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Retained Subject command ranges require forward migration'; END $$;
