CREATE TABLE access.name_graph_import (
  data_epoch text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
