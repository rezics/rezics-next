-- migrate:up
-- A private conversion cursor keeps only source identity and raw coverage. Each
-- page reads retained rows directly; command receipts contain only its interval.
CREATE TABLE content.hosted_migration_input (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  owner_account_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  source_kind text NOT NULL,
  base_revision_id uuid NOT NULL,
  base_placement_count bigint NOT NULL,
  base_root_count bigint NOT NULL,
  source_high_water bigint NOT NULL,
  expected_placement_count bigint NOT NULL,
  frontier_segment text NOT NULL,
  after_ordinal bigint NOT NULL DEFAULT -1,
  after_offset bigint NOT NULL DEFAULT -1,
  raw_visited bigint NOT NULL DEFAULT 0,
  coverage_complete boolean NOT NULL DEFAULT false,
  state text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (route,catalogue_id,input_id),
  CONSTRAINT hosted_migration_input_route_check CHECK (
    route=((get_byte(uuid_send(catalogue_id),10)*256)+get_byte(uuid_send(catalogue_id),11))
    AND route=((get_byte(uuid_send(input_id),10)*256)+get_byte(uuid_send(input_id),11))
  ),
  CONSTRAINT hosted_migration_input_catalogue_fk FOREIGN KEY (route,catalogue_id)
    REFERENCES content.hosted_catalogue(route,catalogue_id),
  CONSTRAINT hosted_migration_input_kind_check CHECK (source_kind IN ('snapshot','prefix')),
  CONSTRAINT hosted_migration_input_source_check CHECK (
    base_placement_count BETWEEN 0 AND 9007199254740991
    AND base_root_count BETWEEN 0 AND base_placement_count
    AND source_high_water BETWEEN -1 AND 9007199254740990
    AND expected_placement_count BETWEEN 0 AND 9007199254740991
    AND expected_placement_count=base_placement_count
      + CASE WHEN source_kind='prefix' AND source_high_water>=0 THEN source_high_water+1 ELSE 0 END
    AND ((source_kind='snapshot' AND source_revision_id=base_revision_id AND source_high_water=-1)
      OR source_kind='prefix')
  ),
  CONSTRAINT hosted_migration_input_frontier_check CHECK (
    frontier_segment IN ('base','prefix','complete')
    AND after_ordinal BETWEEN -1 AND base_placement_count
    AND after_offset BETWEEN -1 AND source_high_water
    AND (frontier_segment<>'prefix' OR source_kind='prefix')
  ),
  CONSTRAINT hosted_migration_input_coverage_check CHECK (
    raw_visited BETWEEN 0 AND expected_placement_count
    AND (NOT coverage_complete OR
      (state IN ('complete','consumed','cancelled','expired') AND raw_visited=expected_placement_count))
  ),
  CONSTRAINT hosted_migration_input_state_check CHECK (
    state IN ('open','complete','incomplete','consumed','cancelled','expired','source_erased')
  ),
  CONSTRAINT hosted_migration_input_time_check CHECK (
    isfinite(expires_at) AND isfinite(created_at) AND isfinite(updated_at) AND expires_at>created_at
  )
);

CREATE INDEX hosted_migration_input_owner_idx
  ON content.hosted_migration_input(route,catalogue_id,owner_account_id,input_id);

CREATE TABLE content.hosted_migration_input_reference (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  base_revision_id uuid NOT NULL,
  PRIMARY KEY (route,catalogue_id,input_id),
  CONSTRAINT hosted_migration_input_reference_input_fk FOREIGN KEY (route,catalogue_id,input_id)
    REFERENCES content.hosted_migration_input(route,catalogue_id,input_id),
  CONSTRAINT hosted_migration_input_reference_source_fk FOREIGN KEY (route,catalogue_id,source_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  CONSTRAINT hosted_migration_input_reference_base_fk FOREIGN KEY (route,catalogue_id,base_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id)
);

CREATE INDEX hosted_migration_input_reference_source_idx
  ON content.hosted_migration_input_reference(route,catalogue_id,source_revision_id,input_id);

-- Source-owned erasure releases a conversion hold in the same native Post
-- transaction. No title or page payload is kept in the input table or receipt.
CREATE FUNCTION content.release_hosted_migration_input_on_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_route integer;
  source_catalogue uuid;
  terminal boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    source_route := OLD.route;
    source_catalogue := OLD.post_id;
    terminal := true;
  ELSE
    source_route := NEW.route;
    source_catalogue := NEW.post_id;
    terminal := NEW.availability='erased' OR NEW.author_erased;
  END IF;
  IF terminal THEN
    UPDATE content.hosted_migration_input i
       SET state='source_erased',coverage_complete=false,updated_at=transaction_timestamp()
      FROM content.hosted_migration_input_reference h
     WHERE h.route=source_route AND h.catalogue_id=source_catalogue
       AND i.route=h.route AND i.catalogue_id=h.catalogue_id AND i.input_id=h.input_id
       AND i.state IN ('open','complete','incomplete');
    DELETE FROM content.hosted_migration_input_reference
     WHERE route=source_route AND catalogue_id=source_catalogue;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_migration_input_source_erasure
  AFTER UPDATE OF availability,author_erased OR DELETE ON content.post
  FOR EACH ROW EXECUTE FUNCTION content.release_hosted_migration_input_on_erasure();

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_migration_input LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back hosted migration input with retained checkpoints' USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TRIGGER hosted_migration_input_source_erasure ON content.post;
DROP FUNCTION content.release_hosted_migration_input_on_erasure();
DROP TABLE content.hosted_migration_input_reference;
DROP INDEX content.hosted_migration_input_owner_idx;
DROP TABLE content.hosted_migration_input;
