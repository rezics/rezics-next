-- migrate:up
-- Bind the native version builder to either its original migration input or
-- one actor-bound retained public publication. Both sources share the same
-- private points, sequence nodes, page receipts and seal state.
CREATE TABLE content.hosted_version_builder_source (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('migration','public')),
  migration_input_id uuid,
  publication_id uuid,
  thread_id uuid,
  actor_binding bytea,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (route,catalogue_id,input_id),
  UNIQUE (route,catalogue_id,publication_id,actor_binding),
  FOREIGN KEY (route,catalogue_id) REFERENCES content.hosted_catalogue(route,catalogue_id),
  FOREIGN KEY (route,catalogue_id,migration_input_id)
    REFERENCES content.hosted_migration_input(route,catalogue_id,input_id),
  FOREIGN KEY (route,catalogue_id,publication_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  CHECK (
    route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)
    AND route=get_byte(uuid_send(input_id),10)*256+get_byte(uuid_send(input_id),11)
    AND (thread_id IS NULL OR route=get_byte(uuid_send(thread_id),10)*256+get_byte(uuid_send(thread_id),11))
  ),
  CHECK (
    (source_kind='migration' AND migration_input_id=input_id AND publication_id IS NULL
      AND thread_id IS NULL AND actor_binding IS NULL)
    OR (source_kind='public' AND migration_input_id IS NULL AND publication_id IS NOT NULL
      AND thread_id IS NOT NULL AND actor_binding IS NOT NULL AND octet_length(actor_binding)=32)
  ),
  CHECK (isfinite(created_at))
);

INSERT INTO content.hosted_version_builder_source
  (route,catalogue_id,input_id,source_kind,migration_input_id,created_at)
SELECT route,catalogue_id,input_id,'migration',input_id,created_at
FROM content.hosted_version_builder;

ALTER TABLE content.hosted_version_builder
  DROP CONSTRAINT hosted_version_builder_route_catalogue_id_input_id_fkey;
ALTER TABLE content.hosted_version_builder
  ADD CONSTRAINT hosted_version_builder_route_catalogue_id_input_id_fkey
  FOREIGN KEY (route,catalogue_id,input_id)
  REFERENCES content.hosted_version_builder_source(route,catalogue_id,input_id);

ALTER TABLE content.hosted_version_builder
  DROP CONSTRAINT hosted_version_builder_source_kind_check;
ALTER TABLE content.hosted_version_builder
  ADD CONSTRAINT hosted_version_builder_source_kind_check
  CHECK (source_kind IN ('snapshot','prefix','public'));

ALTER TABLE content.hosted_version_builder
  DROP CONSTRAINT hosted_version_builder_check1;
ALTER TABLE content.hosted_version_builder
  ADD CONSTRAINT hosted_version_builder_check1 CHECK (
    base_placement_count BETWEEN 0 AND 9007199254740991
    AND base_root_count BETWEEN 0 AND base_placement_count
    AND source_high_water BETWEEN -1 AND 9007199254740990
    AND expected_placement_count BETWEEN 0 AND 9007199254740991
    AND expected_placement_count=base_placement_count
      + CASE WHEN source_kind='prefix' AND source_high_water>=0 THEN source_high_water+1 ELSE 0 END
    AND (
      (source_kind='snapshot' AND source_revision_id=base_revision_id AND source_high_water=-1)
      OR source_kind='prefix'
      OR (source_kind='public' AND source_revision_id=base_revision_id AND source_high_water=-1
        AND expected_placement_count=base_placement_count AND base_root_count=0)
    )
  );

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_version_builder WHERE source_kind='public' LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back hosted public baseline builds with retained state' USING ERRCODE='23514';
  END IF;
END;
$$;

ALTER TABLE content.hosted_version_builder
  DROP CONSTRAINT hosted_version_builder_route_catalogue_id_input_id_fkey;
ALTER TABLE content.hosted_version_builder
  ADD CONSTRAINT hosted_version_builder_route_catalogue_id_input_id_fkey
  FOREIGN KEY (route,catalogue_id,input_id)
  REFERENCES content.hosted_migration_input(route,catalogue_id,input_id);
ALTER TABLE content.hosted_version_builder
  DROP CONSTRAINT hosted_version_builder_check1;
ALTER TABLE content.hosted_version_builder
  ADD CONSTRAINT hosted_version_builder_check1 CHECK (
    base_placement_count BETWEEN 0 AND 9007199254740991
    AND base_root_count BETWEEN 0 AND base_placement_count
    AND source_high_water BETWEEN -1 AND 9007199254740990
    AND expected_placement_count BETWEEN 0 AND 9007199254740991
    AND expected_placement_count=base_placement_count
      + CASE WHEN source_kind='prefix' AND source_high_water>=0 THEN source_high_water+1 ELSE 0 END
    AND ((source_kind='snapshot' AND source_revision_id=base_revision_id AND source_high_water=-1)
      OR source_kind='prefix')
  );
ALTER TABLE content.hosted_version_builder
  DROP CONSTRAINT hosted_version_builder_source_kind_check;
ALTER TABLE content.hosted_version_builder
  ADD CONSTRAINT hosted_version_builder_source_kind_check CHECK (source_kind IN ('snapshot','prefix'));
DELETE FROM content.hosted_version_builder_source WHERE source_kind='migration';
DROP TABLE content.hosted_version_builder_source;
