-- migrate:up
CREATE TABLE access.exposure_opening (
  "group" text NOT NULL CHECK ("group" ~ '^[a-z][a-z_]{0,62}$'),
  valid tstzrange NOT NULL CHECK (
    NOT isempty(valid) AND NOT lower_inf(valid) AND lower_inc(valid) AND NOT upper_inc(valid)
  ),
  transaction_id uuid NOT NULL,
  PRIMARY KEY ("group", valid WITHOUT OVERLAPS)
);

-- migrate:down
DROP TABLE access.exposure_opening;
