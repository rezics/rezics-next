-- Additive components of one (RatingContext, target): the head count, rating
-- count, sum and a 1-10 histogram. The seal that moves a head also moves its
-- component row, so a read never walks the raters. The head remembers its own
-- value so a revision subtracts exactly what it replaces.
ALTER TABLE access.target_rating_head
  ADD COLUMN value smallint CHECK (value BETWEEN 1 AND 10),
  ADD COLUMN value_known boolean NOT NULL DEFAULT false;
ALTER TABLE access.target_rating_head ALTER COLUMN value_known DROP DEFAULT;
ALTER TABLE access.target_rating_head
  ADD CONSTRAINT target_rating_head_value_known CHECK (value IS NULL OR value_known);

CREATE TABLE access.target_rating_component (
  context text NOT NULL REFERENCES access.rating_aggregate_context(context),
  target text NOT NULL,
  -- Every sealed head, withdrawn included. Heads sealed before this table held
  -- no value (the value lives in the graph): they count here but not in the
  -- sums, and `unvalued` counts them until a verified read or their rater's
  -- next revision records the value.
  slots integer NOT NULL CHECK (slots > 0),
  unvalued integer NOT NULL CHECK (unvalued BETWEEN 0 AND slots),
  rating_count integer NOT NULL CHECK (rating_count >= 0),
  rating_sum bigint NOT NULL CHECK (rating_sum >= 0),
  histogram integer[] NOT NULL,
  -- The last seal applied, whose graph receipt and live head witness the row.
  last_admission_id uuid NOT NULL REFERENCES access.admission(id),
  PRIMARY KEY (context, target),
  CONSTRAINT target_rating_component_histogram CHECK (
    cardinality(histogram) = 10 AND array_position(histogram, NULL) IS NULL AND 0 <= ALL(histogram)
    AND rating_count = histogram[1] + histogram[2] + histogram[3] + histogram[4] + histogram[5]
      + histogram[6] + histogram[7] + histogram[8] + histogram[9] + histogram[10]
    AND rating_sum = histogram[1] + 2 * histogram[2] + 3 * histogram[3] + 4 * histogram[4]
      + 5 * histogram[5] + 6 * histogram[6] + 7 * histogram[7] + 8 * histogram[8]
      + 9 * histogram[9] + 10 * histogram[10]
    AND rating_count + unvalued <= slots)
);

-- SQL cannot read the graph, so existing heads are counted and left unvalued.
INSERT INTO access.target_rating_component
  (context, target, slots, unvalued, rating_count, rating_sum, histogram, last_admission_id)
SELECT h.context, h.target, count(*), count(*), 0, 0, ARRAY[0,0,0,0,0,0,0,0,0,0],
  (array_agg(h.admission_id ORDER BY a.sealed_at DESC NULLS LAST, h.admission_id))[1]
FROM access.target_rating_head h JOIN access.admission a ON a.id = h.admission_id
GROUP BY h.context, h.target;

-- The same components summed over every target of a Context. A ranking's prior
-- mean and weight come from here, so no read scans the Context's targets.
CREATE TABLE access.target_rating_context_component (
  context text PRIMARY KEY REFERENCES access.rating_aggregate_context(context),
  targets integer NOT NULL CHECK (targets > 0),
  slots integer NOT NULL CHECK (slots >= targets),
  unvalued integer NOT NULL CHECK (unvalued BETWEEN 0 AND slots),
  rating_count integer NOT NULL CHECK (rating_count >= 0),
  rating_sum bigint NOT NULL CHECK (rating_sum >= 0),
  histogram integer[] NOT NULL,
  CONSTRAINT target_rating_context_component_histogram CHECK (
    cardinality(histogram) = 10 AND array_position(histogram, NULL) IS NULL AND 0 <= ALL(histogram)
    AND rating_count = histogram[1] + histogram[2] + histogram[3] + histogram[4] + histogram[5]
      + histogram[6] + histogram[7] + histogram[8] + histogram[9] + histogram[10]
    AND rating_sum = histogram[1] + 2 * histogram[2] + 3 * histogram[3] + 4 * histogram[4]
      + 5 * histogram[5] + 6 * histogram[6] + 7 * histogram[7] + 8 * histogram[8]
      + 9 * histogram[9] + 10 * histogram[10]
    AND rating_count + unvalued <= slots)
);
INSERT INTO access.target_rating_context_component
  (context, targets, slots, unvalued, rating_count, rating_sum, histogram)
SELECT context, count(*), sum(slots), sum(unvalued), 0, 0, ARRAY[0,0,0,0,0,0,0,0,0,0]
FROM access.target_rating_component GROUP BY context;
