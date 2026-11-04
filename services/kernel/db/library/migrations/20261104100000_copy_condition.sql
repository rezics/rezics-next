ALTER TABLE library.copy
  ADD COLUMN media_condition jsonb,
  ADD COLUMN packaging_condition jsonb;

CREATE FUNCTION library.copy_condition_observation_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN true
    WHEN jsonb_typeof(value) <> 'object' THEN false
    ELSE jsonb_object_length(value) = 3
      AND value ?& ARRAY['value', 'pin', 'kindId']
      AND jsonb_typeof(value->'kindId') = 'string'
      AND value->>'kindId' ~ '^[a-z][a-z0-9_.-]{0,63}$'
      AND (
        value->'value' = 'null'::jsonb
        OR (
          jsonb_typeof(value->'value') = 'string'
          AND value->>'value' = ANY (ARRAY[
            'unknown', 'mint', 'near_mint', 'very_good_plus',
            'very_good', 'good', 'fair', 'poor'
          ]::text[])
        )
      )
      AND COALESCE(library.library_profile_pin_valid(value->'pin'), false)
  END;
$$;

ALTER TABLE library.copy
  ADD CONSTRAINT copy_media_condition_check
    CHECK (library.copy_condition_observation_valid(media_condition)),
  ADD CONSTRAINT copy_packaging_condition_check
    CHECK (library.copy_condition_observation_valid(packaging_condition));

COMMENT ON COLUMN library.copy.media_condition IS
  'Private physical media observation with its exact accepting profile pin; SQL NULL means not recorded.';
COMMENT ON COLUMN library.copy.packaging_condition IS
  'Private physical packaging observation with its exact accepting profile pin; SQL NULL means not recorded.';
