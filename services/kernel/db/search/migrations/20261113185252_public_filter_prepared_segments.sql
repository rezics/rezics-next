-- migrate:up
-- New immutable prepared generations keep their bounded append frontier and rows separately.
ALTER TABLE search.public_filter_prepared
  ADD COLUMN segment_state text NOT NULL DEFAULT 'legacy'
    CHECK (segment_state IN ('legacy','building','complete','erasing')),
  ADD COLUMN raw_count integer NOT NULL DEFAULT 0 CHECK (raw_count BETWEEN 0 AND 1000),
  ADD COLUMN output_count integer NOT NULL DEFAULT 0 CHECK (output_count BETWEEN 0 AND raw_count),
  ADD COLUMN raw_exhausted boolean NOT NULL DEFAULT false,
  ADD COLUMN source_cursor text CHECK (octet_length(source_cursor) <= 4096);

ALTER TABLE search.public_filter_observation
  ADD COLUMN prepared_build text COLLATE "C",
  ADD COLUMN prepared_generation numeric,
  ADD CONSTRAINT public_filter_observation_prepared_build_check CHECK (
    (prepared_build IS NULL AND prepared_generation IS NULL) OR
    (prepared_build IS NOT NULL AND prepared_generation > 0 AND scale(prepared_generation) = 0)
  );
CREATE UNIQUE INDEX public_filter_observation_prepared_build
  ON search.public_filter_observation(partition_no,registration,prepared_build,prepared_generation)
  WHERE prepared_build IS NOT NULL AND state='open';

CREATE TABLE search.public_filter_preparation_segment (
  partition_no integer NOT NULL,
  registration text COLLATE "C" NOT NULL,
  build text COLLATE "C" NOT NULL,
  generation numeric NOT NULL CHECK (generation > 0 AND scale(generation) = 0),
  raw_ordinal integer NOT NULL CHECK (raw_ordinal BETWEEN 0 AND 999),
  output_ordinal integer CHECK (output_ordinal BETWEEN 0 AND 999),
  payload jsonb NOT NULL,
  PRIMARY KEY (partition_no,registration,build,generation,raw_ordinal),
  FOREIGN KEY (partition_no,registration,build,generation)
    REFERENCES search.public_filter_prepared(partition_no,registration,build,generation)
);
CREATE UNIQUE INDEX public_filter_preparation_segment_output
  ON search.public_filter_preparation_segment(partition_no,registration,build,generation,output_ordinal)
  WHERE output_ordinal IS NOT NULL;

-- migrate:down
-- Forward only: prepared segment rows and generation refusal are retained for replay and erasure.
