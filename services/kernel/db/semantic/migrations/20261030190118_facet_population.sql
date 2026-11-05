-- migrate:up
-- Derived preparation frontiers only. Source and immutable consumer registration remain owner data.
CREATE TABLE semantic.facet_population_frontier (
  partition_no integer NOT NULL REFERENCES core.partition (partition_no),
  frontier uuid NOT NULL,
  predecessor uuid,
  observation text NOT NULL,
  binding text NOT NULL,
  capture text NOT NULL,
  state jsonb NOT NULL,
  subjects jsonb NOT NULL CHECK (jsonb_typeof(subjects) = 'array' AND jsonb_array_length(subjects) <= 256),
  complete boolean NOT NULL,
  expires bigint NOT NULL,
  PRIMARY KEY (partition_no, frontier),
  FOREIGN KEY (partition_no, predecessor) REFERENCES semantic.facet_population_frontier (partition_no, frontier)
);
CREATE UNIQUE INDEX facet_population_successor ON semantic.facet_population_frontier (partition_no, predecessor)
WHERE predecessor IS NOT NULL;
CREATE INDEX facet_population_expiry ON semantic.facet_population_frontier (partition_no, expires, frontier);

-- migrate:down
DROP TABLE semantic.facet_population_frontier;
