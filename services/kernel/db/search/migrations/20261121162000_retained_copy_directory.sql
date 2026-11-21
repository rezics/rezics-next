-- migrate:up
-- Compatible with the scalar producer: empty lanes leave every retained erasure
-- cursor at precisely the revision it already observed.
CREATE TABLE search.retained_copy_lane (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  physical_target text COLLATE "C" NOT NULL,
  lane integer NOT NULL CHECK (lane BETWEEN 0 AND 31),
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (partition_no,physical_target,lane),
  FOREIGN KEY (partition_no,physical_target) REFERENCES search.public_filter_target(partition_no,physical_target)
);

CREATE VIEW search.retained_copy_directory AS
SELECT t.partition_no,t.physical_target,t.incarnation,(t.copy_revision+COALESCE(l.increment,0))::bigint AS copy_revision
FROM search.public_filter_target t
CROSS JOIN LATERAL (
  SELECT sum(revision) AS increment FROM search.retained_copy_lane
  WHERE (partition_no,physical_target)=(t.partition_no,t.physical_target)
) l;

-- Lock the current incarnation before locking the registration. Scalar admissions
-- still update the target row; all coexisting producers must take its write lock first.
CREATE FUNCTION search.lock_retained_copy_target(integer,text)
RETURNS TABLE(partition_no integer,physical_target text,incarnation text)
LANGUAGE sql VOLATILE ROWS 1 AS $$
  SELECT t.partition_no,t.physical_target,t.incarnation FROM search.public_filter_target t
  WHERE (t.partition_no,t.physical_target)=($1,$2) FOR NO KEY UPDATE
$$;

-- migrate:down
DROP FUNCTION search.lock_retained_copy_target(integer,text);
DROP VIEW search.retained_copy_directory;
DROP TABLE search.retained_copy_lane;
