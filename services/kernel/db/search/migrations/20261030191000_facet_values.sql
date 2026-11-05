-- migrate:up
-- Derived facets only; Source owns membership, finite population and privacy cuts.
CREATE TABLE search.facet_generation (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  definition text COLLATE "C" NOT NULL,
  generation text COLLATE "C" NOT NULL,
  property text NOT NULL,
  observation text NOT NULL,
  state text NOT NULL CHECK (state IN ('building','ready','retired')),
  phase text NOT NULL CHECK (phase IN ('population','projection','contribute','seal')),
  version bigint NOT NULL DEFAULT 1,
  lease_until bigint NOT NULL DEFAULT 0,
  expires_at bigint NOT NULL,
  frontier text,
  population_complete boolean NOT NULL DEFAULT false,
  subject text,
  terminal text,
  subject_type text,
  security_revision text,
  projection jsonb,
  accumulator jsonb NOT NULL DEFAULT '[]',
  contribution_after text COLLATE "C",
  as_of text,
  PRIMARY KEY (partition_no,definition,generation)
);
CREATE UNIQUE INDEX facet_one_building ON search.facet_generation (partition_no,definition) WHERE state='building';
CREATE UNIQUE INDEX facet_one_ready ON search.facet_generation (partition_no,definition) WHERE state='ready';
CREATE INDEX facet_expiry ON search.facet_generation (expires_at,partition_no,definition,generation);
CREATE TABLE search.facet_stage (
  partition_no integer NOT NULL,
  definition text COLLATE "C" NOT NULL,
  generation text COLLATE "C" NOT NULL,
  subject text COLLATE "C" NOT NULL,
  key text COLLATE "C" NOT NULL,
  value text COLLATE "C" NOT NULL,
  labels jsonb NOT NULL,
  target_original text,
  target_terminal text,
  PRIMARY KEY (partition_no,definition,generation,subject,key),
  FOREIGN KEY (partition_no,definition,generation) REFERENCES search.facet_generation
);
CREATE TABLE search.facet_value (
  partition_no integer NOT NULL,
  definition text COLLATE "C" NOT NULL,
  generation text COLLATE "C" NOT NULL,
  value text COLLATE "C" NOT NULL,
  labels jsonb NOT NULL,
  contributor_original text NOT NULL,
  contributor_terminal text NOT NULL,
  target_original text,
  target_terminal text,
  PRIMARY KEY (partition_no,definition,generation,value),
  FOREIGN KEY (partition_no,definition,generation) REFERENCES search.facet_generation
);
-- migrate:down
-- Forward-only derived state, reclaimed in bounded retired-generation pages.
