-- migrate:up
CREATE FUNCTION community.realm_presentation_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; ref jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR
     NOT value ?& ARRAY['avatarMediaId','bannerMediaId','rules'] OR
     (SELECT count(*) FROM jsonb_object_keys(value)) <> 3 THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['avatarMediaId','bannerMediaId'] LOOP
    ref := value -> key;
    IF ref <> 'null'::jsonb AND (jsonb_typeof(ref) <> 'string' OR
      (ref #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN false; END IF;
  END LOOP;
  ref := value -> 'rules';
  IF ref = 'null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(ref) <> 'object' OR NOT ref ?& ARRAY['postId','revisionId'] OR
     (SELECT count(*) FROM jsonb_object_keys(ref)) <> 2 THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['postId','revisionId'] LOOP
    IF jsonb_typeof(ref -> key) <> 'string' OR (ref ->> key) !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
ALTER TABLE community.realm_revision ADD COLUMN presentation jsonb NOT NULL
  DEFAULT '{"avatarMediaId":null,"bannerMediaId":null,"rules":null}'::jsonb
  CONSTRAINT realm_revision_presentation_check CHECK (community.realm_presentation_allowed(presentation));

-- migrate:down
-- Forward only: presentation references belong to immutable Realm revisions.
