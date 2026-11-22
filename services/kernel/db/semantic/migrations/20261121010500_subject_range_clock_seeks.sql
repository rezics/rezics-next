-- migrate:up
-- Each page intersects at most two 32-home clocks. An ordered successor seek
-- followed by exact equality detects a missing clock without walking its peers.
CREATE OR REPLACE FUNCTION semantic.subject_access_range_revisions_v1(lo integer, hi integer) RETURNS uuid[]
    LANGUAGE sql STABLE
    AS $$
  WITH bounds AS (
    SELECT lo/32*32 AS start_home,(hi-1)/32*32 AS final_home
    WHERE lo BETWEEN 0 AND 4095 AND hi BETWEEN 1 AND 4096 AND hi::bigint-lo BETWEEN 1 AND 32
  )
  SELECT CASE WHEN count(*)=(final_home-start_home)/32+1 THEN array_agg(r.revision ORDER BY h.home) END
  FROM bounds CROSS JOIN LATERAL generate_series(start_home,final_home,32) h(home)
  JOIN LATERAL (
    SELECT first_home,revision FROM semantic.subject_access_range_revision_v1
    WHERE first_home>=h.home ORDER BY first_home LIMIT 1
  ) r ON r.first_home=h.home
  GROUP BY start_home,final_home
$$;

CREATE OR REPLACE FUNCTION semantic.subject_quiet_page_current_v1(p semantic.subject_access_page_v1) RETURNS boolean
    LANGUAGE sql STABLE STRICT
    AS $$
  WITH stamp AS MATERIALIZED (
    SELECT semantic.subject_access_range_revisions_v1(p.first_home,p.end_home) AS revisions
    WHERE p.quiet_digest IS NOT NULL
  )
  SELECT EXISTS (SELECT FROM stamp WHERE cardinality(revisions)=1 AND
    (p.access_revisions=revisions OR EXISTS (SELECT FROM semantic.subject_quiet_recheck_v1 q
      WHERE (q.birth,q.first_home,q.revision)=(p.birth,p.first_home,revisions[1]))))
$$;

CREATE OR REPLACE FUNCTION semantic.verify_subject_quiet_recheck_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p semantic.subject_access_page_v1;
BEGIN
  SELECT * INTO STRICT p FROM semantic.subject_access_page_v1 WHERE (birth,first_home)=(NEW.birth,NEW.first_home);
  IF p.quiet_digest IS NULL THEN RAISE EXCEPTION 'Missing original empty Subject interval'; END IF;
  SELECT revision INTO STRICT NEW.revision
    FROM unnest(semantic.subject_access_range_revisions_v1(p.first_home,p.end_home)) revision;
  IF semantic.capture_subject_access_page_v1(p.birth,p.first_home,p.end_home) IS DISTINCT FROM p.cuts
    THEN RAISE EXCEPTION 'Subject interval changed'; END IF;
  RETURN NEW;
END $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.subject_access_range_revisions_v1(lo integer, hi integer) RETURNS uuid[]
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE WHEN count(*)=(hi-1)/32-lo/32+1 THEN array_agg(revision ORDER BY first_home) END
  FROM semantic.subject_access_range_revision_v1 WHERE first_home BETWEEN lo/32*32 AND (hi-1)/32*32
    AND lo BETWEEN 0 AND 4095 AND hi-lo BETWEEN 1 AND 32 AND hi<=4096
$$;

CREATE OR REPLACE FUNCTION semantic.subject_quiet_page_current_v1(p semantic.subject_access_page_v1) RETURNS boolean
    LANGUAGE sql STABLE STRICT
    AS $$
  SELECT p.quiet_digest IS NOT NULL AND EXISTS (
    SELECT FROM semantic.subject_access_range_revision_v1 s WHERE s.first_home=p.first_home AND
      (p.access_revisions=ARRAY[s.revision] OR EXISTS (SELECT FROM semantic.subject_quiet_recheck_v1 q
        WHERE (q.birth,q.first_home,q.revision)=(p.birth,p.first_home,s.revision))))
$$;

CREATE OR REPLACE FUNCTION semantic.verify_subject_quiet_recheck_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p semantic.subject_access_page_v1;
BEGIN
  SELECT * INTO STRICT p FROM semantic.subject_access_page_v1 WHERE (birth,first_home)=(NEW.birth,NEW.first_home);
  IF p.quiet_digest IS NULL THEN RAISE EXCEPTION 'Missing original empty Subject interval'; END IF;
  SELECT revision INTO STRICT NEW.revision FROM semantic.subject_access_range_revision_v1 WHERE first_home=p.first_home;
  IF semantic.capture_subject_access_page_v1(p.birth,p.first_home,p.end_home) IS DISTINCT FROM p.cuts
    THEN RAISE EXCEPTION 'Subject interval changed'; END IF;
  RETURN NEW;
END $$;
