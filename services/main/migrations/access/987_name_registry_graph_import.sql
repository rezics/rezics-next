CREATE TABLE access.name_graph_import (
  data_epoch text PRIMARY KEY,
  cursor text NOT NULL DEFAULT '',
  completed_at timestamptz
);
