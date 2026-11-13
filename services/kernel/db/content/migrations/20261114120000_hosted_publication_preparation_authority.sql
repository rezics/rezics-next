-- migrate:up
-- Retain only the admitted author provenance needed to continue private
-- preparation. The row is deleted when its stage is terminal or retained away.
CREATE TABLE content.hosted_publication_preparation_authority (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  CONSTRAINT hosted_publication_preparation_authority_pkey PRIMARY KEY (route,catalogue_id,stage_id),
  CONSTRAINT hosted_publication_preparation_authority_stage_fkey FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_publication_staging(route,catalogue_id,stage_id) ON DELETE CASCADE,
  CONSTRAINT hosted_publication_preparation_authority_catalogue_route_check
    CHECK (route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)),
  CONSTRAINT hosted_publication_preparation_authority_stage_route_check
    CHECK (route=get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11))
);

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_publication_preparation_authority LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back retained hosted preparation authority' USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TABLE content.hosted_publication_preparation_authority;
