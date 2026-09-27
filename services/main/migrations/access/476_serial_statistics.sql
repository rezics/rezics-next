CREATE TABLE access.serial_stats_checkpoint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation uuid NOT NULL,
  graph_epoch text NOT NULL,
  sequence numeric(38, 0) NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE access.serial_chapter (
  generation uuid NOT NULL,
  work text NOT NULL,
  occurrence text NOT NULL,
  resource text NOT NULL,
  variant text,
  revision text,
  PRIMARY KEY (generation, work, occurrence)
);
CREATE INDEX serial_chapter_resource_idx ON access.serial_chapter (generation, resource, work);

CREATE TABLE access.serial_content_words (
  generation uuid NOT NULL,
  variant text NOT NULL,
  revision text NOT NULL,
  word_count integer NOT NULL CHECK (word_count >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (generation, variant)
);

CREATE TABLE access.serial_summary (
  generation uuid NOT NULL,
  work text NOT NULL,
  structure text,
  chapter_count integer,
  word_count bigint,
  structure_updated_at timestamptz,
  last_updated_at timestamptz,
  PRIMARY KEY (generation, work)
);
