-- migrate:up
CREATE OR REPLACE FUNCTION semantic.public_filter_native_json(value jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
DECLARE result jsonb;
BEGIN
  CASE value->>0
    WHEN 'scalar','value','bigint' THEN RETURN value->1;
    WHEN 'undefined' THEN RETURN 'null'::jsonb;
    -- Aggregate each container once. Ordinality retains array order and the last duplicate object key.
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(CASE WHEN entry->>0 IN ('scalar','value','bigint') THEN entry->1
        ELSE semantic.public_filter_native_json(entry) END ORDER BY ordinal),'[]'::jsonb)
        INTO result FROM jsonb_array_elements(value->1) WITH ORDINALITY AS items(entry,ordinal);
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(entry->>0,CASE WHEN entry#>>'{1,0}' IN ('scalar','value','bigint') THEN entry#>'{1,1}'
        ELSE semantic.public_filter_native_json(entry->1) END ORDER BY ordinal),'{}'::jsonb)
        INTO result FROM jsonb_array_elements(value->1) WITH ORDINALITY AS items(entry,ordinal);
    ELSE RAISE EXCEPTION 'Invalid native public-filter encoding';
  END CASE;
  RETURN result;
END $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.public_filter_native_json(value jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
DECLARE result jsonb; entry jsonb;
BEGIN
  CASE value->>0
    WHEN 'scalar','value','bigint' THEN RETURN value->1;
    WHEN 'undefined' THEN RETURN 'null'::jsonb;
    WHEN 'array' THEN
      result := '[]'::jsonb;
      FOR entry IN SELECT jsonb_array_elements(value->1) LOOP
        result := result || jsonb_build_array(semantic.public_filter_native_json(entry));
      END LOOP;
      RETURN result;
    WHEN 'object' THEN
      result := '{}'::jsonb;
      FOR entry IN SELECT jsonb_array_elements(value->1) LOOP
        result := result || jsonb_build_object(entry->>0,semantic.public_filter_native_json(entry->1));
      END LOOP;
      RETURN result;
    ELSE RAISE EXCEPTION 'Invalid native public-filter encoding';
  END CASE;
END $$;
