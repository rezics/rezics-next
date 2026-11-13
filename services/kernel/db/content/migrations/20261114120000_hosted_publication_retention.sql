-- Global due-order discovery for hosted Book preparation uses one bounded keyset.
CREATE INDEX hosted_publication_staging_retention_expiry
  ON content.hosted_publication_staging(expires_at,route,catalogue_id,stage_id);

-- One durable cursor and replay result for Content's existing collection sweep.
CREATE TABLE content.hosted_publication_retention_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  after_expires_at timestamptz,
  after_route integer,
  after_catalogue_id uuid,
  after_stage_id uuid,
  last_pass_id text,
  last_pass_result jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(updated_at)),
  CHECK (
    (after_expires_at IS NULL AND after_route IS NULL AND after_catalogue_id IS NULL AND after_stage_id IS NULL)
    OR
    (after_expires_at IS NOT NULL AND after_route BETWEEN 0 AND 65535
      AND after_catalogue_id IS NOT NULL AND after_stage_id IS NOT NULL
      AND after_route=get_byte(uuid_send(after_catalogue_id),10)*256+get_byte(uuid_send(after_catalogue_id),11)
      AND after_route=get_byte(uuid_send(after_stage_id),10)*256+get_byte(uuid_send(after_stage_id),11))
  ),
  CHECK ((last_pass_id IS NULL)=(last_pass_result IS NULL)),
  CHECK (last_pass_result IS NULL OR jsonb_typeof(last_pass_result)='object')
);

-- Ineligible retained stages move the cursor and leave their exact source identity and reason visible.
CREATE TABLE content.hosted_publication_retention_issue (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  owner_epoch bigint NOT NULL CHECK (owner_epoch >= 0),
  source_revision_id uuid NOT NULL,
  candidate_generation_id uuid,
  state text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(observed_at)),
  PRIMARY KEY (route,catalogue_id,stage_id),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_publication_staging(route,catalogue_id,stage_id),
  FOREIGN KEY (route,catalogue_id,source_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  CHECK (route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)),
  CHECK (route=get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)),
  CHECK (route=get_byte(uuid_send(source_revision_id),10)*256+get_byte(uuid_send(source_revision_id),11)),
  CHECK (candidate_generation_id IS NULL OR
    route=get_byte(uuid_send(candidate_generation_id),10)*256+get_byte(uuid_send(candidate_generation_id),11))
);

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_publication_retention_issue LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back hosted publication retention while recovery states remain'
      USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TABLE content.hosted_publication_retention_issue;
DROP TABLE content.hosted_publication_retention_cursor;
DROP INDEX content.hosted_publication_staging_retention_expiry;
