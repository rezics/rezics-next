CREATE TABLE access.name_graph_import (
  data_epoch text PRIMARY KEY,
  cursor text NOT NULL DEFAULT '',
  completed_at timestamptz
);
CREATE TABLE access.name_graph_import_report (
  data_epoch text NOT NULL,
  source text NOT NULL,
  reason text NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(data_epoch,source)
);
