-- A bounded changed-Work list makes the delta checkpoint durable. Unchanged
-- entries are copied into the new immutable generation before graph hydration.
ALTER TABLE access.discovery_generation ADD COLUMN changed_works jsonb
  CHECK (changed_works IS NULL OR (jsonb_typeof(changed_works) = 'array'
    AND jsonb_array_length(changed_works) <= 2000));
