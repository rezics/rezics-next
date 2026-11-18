-- migrate:up
CREATE UNLOGGED TABLE semantic.link_read_demand (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  expires_at timestamp with time zone NOT NULL
);

-- migrate:down
DROP TABLE semantic.link_read_demand;
