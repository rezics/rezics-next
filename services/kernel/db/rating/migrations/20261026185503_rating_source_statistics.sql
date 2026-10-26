-- migrate:up
CREATE TABLE rating.source_statistic (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  source text NOT NULL CHECK (source = 'vndb'),
  source_record_id text NOT NULL CHECK (char_length(source_record_id) BETWEEN 1 AND 1024),
  scale_min integer NOT NULL CHECK (scale_min >= 0),
  scale_max integer NOT NULL,
  mean numeric NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  as_of date NOT NULL,
  licence text NOT NULL CHECK (char_length(licence) BETWEEN 1 AND 1024),
  attribution text NOT NULL CHECK (char_length(attribution) BETWEEN 1 AND 2000),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, source),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  CHECK (scale_max > scale_min),
  CHECK (mean BETWEEN scale_min AND scale_max),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);

-- migrate:down
-- Forward only: imported source statistics and their provenance must not be discarded by rollback.
