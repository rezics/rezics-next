-- migrate:up
-- Wait for normal writers in their target-first order. If an independent
-- producer already owns a child table, release this whole cutover and retry.
LOCK TABLE search.public_filter_target IN ACCESS EXCLUSIVE MODE;
LOCK TABLE search.public_filter_registration,search.public_filter_prepared,
  search.public_filter_observation,search.retained_copy_lane IN SHARE ROW EXCLUSIVE MODE NOWAIT;
-- A pre-directory eraser reaching this point must retry instead of accepting
-- a frozen scalar. PostgreSQL retains the view dependency across the rename.
ALTER TABLE search.public_filter_target RENAME COLUMN copy_revision TO base_copy_revision;

CREATE OR REPLACE FUNCTION search.lock_retained_copy_target(integer,text)
RETURNS TABLE(partition_no integer,physical_target text,incarnation text)
LANGUAGE sql VOLATILE ROWS 1 AS $$
  SELECT t.partition_no,t.physical_target,t.incarnation FROM search.public_filter_target t
  WHERE (t.partition_no,t.physical_target)=($1,$2) FOR SHARE
$$;

CREATE OR REPLACE FUNCTION search.enroll_retained_copy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_name text;
BEGIN
  IF TG_TABLE_NAME='public_filter_registration' THEN
    target_name := NEW.physical_target;
  ELSE
    SELECT physical_target INTO target_name FROM search.public_filter_registration
      WHERE (partition_no,id)=(NEW.partition_no,NEW.registration);
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(target_name,741));
  IF EXISTS(SELECT 1 FROM search.identity_writer_gate
    WHERE partition_no=0 AND physical_target=target_name AND publication_fence IS NOT NULL) THEN
    RAISE EXCEPTION 'Search generation is fenced for native publication';
  END IF;
  -- Every native copy in this transaction uses one lane, including a batch of
  -- observations and its independent prepared header. No lock order between lanes is needed.
  INSERT INTO search.retained_copy_lane(partition_no,physical_target,lane,revision)
    VALUES(NEW.partition_no,target_name,(hashtextextended(pg_current_xact_id()::text,0) & 31)::integer,1)
  ON CONFLICT(partition_no,physical_target,lane) DO UPDATE SET revision=search.retained_copy_lane.revision+1;
  RETURN NEW;
END $$;

-- migrate:down
-- Wait for normal writers in their target-first order. If an independent
-- producer already owns a child table, release this whole cutover and retry.
LOCK TABLE search.public_filter_target IN ACCESS EXCLUSIVE MODE;
LOCK TABLE search.public_filter_registration,search.public_filter_prepared,
  search.public_filter_observation,search.retained_copy_lane IN SHARE ROW EXCLUSIVE MODE NOWAIT;
-- Drain producers before folding committed lane deltas into the original
-- scalar. Existing erasure cursors keep the same exact value in both versions.
UPDATE search.public_filter_target t
SET base_copy_revision=(t.base_copy_revision+l.increment)::bigint
FROM (
  SELECT partition_no,physical_target,sum(revision) AS increment
  FROM search.retained_copy_lane GROUP BY partition_no,physical_target
) l
WHERE (t.partition_no,t.physical_target)=(l.partition_no,l.physical_target);
TRUNCATE search.retained_copy_lane;
ALTER TABLE search.public_filter_target RENAME COLUMN base_copy_revision TO copy_revision;

CREATE OR REPLACE FUNCTION search.lock_retained_copy_target(integer,text)
RETURNS TABLE(partition_no integer,physical_target text,incarnation text)
LANGUAGE sql VOLATILE ROWS 1 AS $$
  SELECT t.partition_no,t.physical_target,t.incarnation FROM search.public_filter_target t
  WHERE (t.partition_no,t.physical_target)=($1,$2) FOR NO KEY UPDATE
$$;

CREATE OR REPLACE FUNCTION search.enroll_retained_copy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_name text;
BEGIN
  IF TG_TABLE_NAME='public_filter_registration' THEN
    target_name := NEW.physical_target;
  ELSE
    SELECT physical_target INTO target_name FROM search.public_filter_registration
      WHERE (partition_no,id)=(NEW.partition_no,NEW.registration);
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(target_name,741));
  IF EXISTS(SELECT 1 FROM search.identity_writer_gate
    WHERE partition_no=0 AND physical_target=target_name AND publication_fence IS NOT NULL) THEN
    RAISE EXCEPTION 'Search generation is fenced for native publication';
  END IF;
  IF TG_TABLE_NAME='public_filter_registration' THEN
    UPDATE search.public_filter_target SET copy_revision=copy_revision+1
      WHERE partition_no=NEW.partition_no AND physical_target=NEW.physical_target;
  ELSE
    UPDATE search.public_filter_target t SET copy_revision=t.copy_revision+1
      FROM search.public_filter_registration r
      WHERE (r.partition_no,r.id)=(NEW.partition_no,NEW.registration)
        AND (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target);
  END IF;
  RETURN NEW;
END $$;
