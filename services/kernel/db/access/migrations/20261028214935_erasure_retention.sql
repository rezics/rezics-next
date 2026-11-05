-- migrate:up
ALTER TABLE access.erasure_acknowledgement
  ADD COLUMN retained jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN resolutions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT erasure_acknowledgement_retained_check CHECK (
    jsonb_typeof(retained) = 'array' AND jsonb_array_length(retained) <= 16
    AND (outcome = 'erased' OR retained = '[]'::jsonb)),
  ADD CONSTRAINT erasure_acknowledgement_resolutions_check CHECK (jsonb_typeof(resolutions) = 'object');

CREATE OR REPLACE FUNCTION access.guard_erasure_acknowledgement() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  store text;
  resolved jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Erasure acknowledgements are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.route IS DISTINCT FROM OLD.route OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.participant IS DISTINCT FROM OLD.participant OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.retained IS DISTINCT FROM OLD.retained OR NOT (NEW.resolutions @> OLD.resolutions) THEN
    RAISE EXCEPTION 'Erasure acknowledgements are immutable' USING ERRCODE = '23514';
  END IF;
  FOR store, resolved IN SELECT key, value FROM jsonb_each(NEW.resolutions) LOOP
    IF jsonb_typeof(resolved) <> 'string' OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.retained) x
      WHERE x->>'store' = store AND (x->>'expiresAt')::timestamptz <= (resolved #>> '{}')::timestamptz
    ) THEN
      RAISE EXCEPTION 'Invalid retention resolution' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION access.guard_erasure_acknowledgement() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Erasure acknowledgements are immutable' USING ERRCODE = '23514';
END;
$$;
ALTER TABLE access.erasure_acknowledgement DROP COLUMN resolutions, DROP COLUMN retained;
