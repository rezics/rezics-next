-- migrate:up
CREATE SCHEMA core;

CREATE TABLE core.partition (
  partition_no integer PRIMARY KEY CHECK (partition_no >= 0),
  node text NOT NULL,
  write_state text NOT NULL DEFAULT 'active' CHECK (write_state IN ('active', 'fenced', 'moved')),
  moved_to text,
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
  position bigint NOT NULL DEFAULT 0 CHECK (position >= 0),
  CHECK ((write_state = 'moved') = (moved_to IS NOT NULL))
);

INSERT INTO core.partition (partition_no, node)
SELECT partition_no, 'b'
FROM generate_series(0, 4095) AS partition_no;

-- migrate:down
DROP TABLE core.partition;
DROP SCHEMA core;
