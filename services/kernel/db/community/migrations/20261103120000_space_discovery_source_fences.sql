-- Source tuple identity is read from the owning producer and installed as an
-- inverse at tuple home through resumable, separately committed work.
CREATE SEQUENCE community.space_discovery_tuple_witness_key;
CREATE SEQUENCE community.space_discovery_tuple_inverse_key;

CREATE TABLE community.space_discovery_tuple_capability (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  cut bigint NOT NULL DEFAULT 0 CHECK (cut >= 0),
  required bigint NOT NULL DEFAULT 0 CHECK (required >= 0),
  witnessed bigint NOT NULL DEFAULT 0 CHECK (witnessed >= 0),
  pending bigint NOT NULL DEFAULT 0 CHECK (pending >= 0),
  CHECK (witnessed + pending = required)
);
INSERT INTO community.space_discovery_tuple_capability(partition_no)
SELECT generate_series(0,4095);

CREATE TABLE community.space_discovery_tuple_producer (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation text NOT NULL CHECK (generation <> '' AND char_length(generation) <= 128),
  cut text NOT NULL CHECK (cut <> '' AND char_length(cut) <= 256),
  complete boolean NOT NULL DEFAULT false
);

CREATE TABLE community.space_discovery_tuple_witness (
  route integer NOT NULL,
  space_id uuid NOT NULL,
  witness_generation bigint NOT NULL DEFAULT nextval('community.space_discovery_tuple_witness_key'),
  space_revision uuid,
  realm_id uuid,
  realm_revision uuid,
  producer_generation text,
  producer_epoch numeric(20,0) NOT NULL DEFAULT 0 CHECK (producer_epoch >= 0),
  source_position numeric(20,0) NOT NULL DEFAULT 0 CHECK (source_position >= 0),
  tuple_count smallint NOT NULL DEFAULT 0 CHECK (tuple_count BETWEEN 0 AND 50),
  state text NOT NULL DEFAULT 'unavailable' CHECK (state IN ('preparing','unavailable','ready')),
  PRIMARY KEY (route,space_id),
  FOREIGN KEY (route,space_id) REFERENCES community.space(route,space_id) ON DELETE CASCADE,
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (state <> 'ready' OR (space_revision IS NOT NULL AND producer_generation IS NOT NULL))
);
CREATE INDEX space_discovery_tuple_witness_pending
  ON community.space_discovery_tuple_witness(route,space_id) WHERE state <> 'ready';

CREATE TABLE community.space_discovery_tuple_expected (
  route integer NOT NULL,
  space_id uuid NOT NULL,
  witness_generation bigint NOT NULL,
  tuple_route integer NOT NULL,
  source text NOT NULL COLLATE "C",
  external_id text NOT NULL COLLATE "C",
  field_group text NOT NULL COLLATE "C",
  PRIMARY KEY (route,space_id,witness_generation,tuple_route,source,external_id,field_group),
  FOREIGN KEY (route,space_id) REFERENCES community.space(route,space_id) ON DELETE CASCADE,
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (tuple_route BETWEEN 0 AND 65535),
  CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CHECK (char_length(external_id) BETWEEN 1 AND 1024),
  CHECK (field_group IN ('facts','summary','cover'))
);

CREATE TABLE community.space_discovery_tuple_reference (
  route integer NOT NULL,
  space_id uuid NOT NULL,
  tuple_route integer NOT NULL,
  source text NOT NULL COLLATE "C",
  external_id text NOT NULL COLLATE "C",
  field_group text NOT NULL COLLATE "C",
  witness_generation bigint NOT NULL,
  PRIMARY KEY (route,space_id,tuple_route,source,external_id,field_group),
  FOREIGN KEY (route,space_id) REFERENCES community.space(route,space_id) ON DELETE CASCADE,
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (tuple_route BETWEEN 0 AND 65535),
  CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CHECK (char_length(external_id) BETWEEN 1 AND 1024),
  CHECK (field_group IN ('facts','summary','cover'))
);
CREATE INDEX space_discovery_tuple_reference_owner
  ON community.space_discovery_tuple_reference(route,space_id);

CREATE TABLE community.space_discovery_tuple_work (
  route integer NOT NULL,
  space_id uuid NOT NULL,
  witness_generation bigint NOT NULL,
  tuple_route integer NOT NULL,
  source text NOT NULL COLLATE "C",
  external_id text NOT NULL COLLATE "C",
  field_group text NOT NULL COLLATE "C",
  action text NOT NULL CHECK (action IN ('upsert','remove')),
  producer_epoch numeric(20,0) NOT NULL CHECK (producer_epoch >= 0),
  source_position numeric(20,0) NOT NULL CHECK (source_position >= 0),
  PRIMARY KEY (route,space_id,witness_generation,tuple_route,source,external_id,field_group,action),
  FOREIGN KEY (route,space_id) REFERENCES community.space(route,space_id) ON DELETE CASCADE,
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (tuple_route BETWEEN 0 AND 65535),
  CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CHECK (char_length(external_id) BETWEEN 1 AND 1024),
  CHECK (field_group IN ('facts','summary','cover'))
);
CREATE INDEX space_discovery_tuple_work_pending
  ON community.space_discovery_tuple_work(route,space_id,witness_generation);

-- The inverse is stored in the source tuple's partition. Retired rows are
-- tombstones outside the active covering index so stale work cannot resurrect
-- a retired edge and current prefix scans do not examine retained history.
CREATE TABLE community.space_discovery_tuple_inverse (
  tuple_route integer NOT NULL,
  source text NOT NULL COLLATE "C",
  external_id text NOT NULL COLLATE "C",
  field_group text NOT NULL COLLATE "C",
  space_route integer NOT NULL,
  space_id uuid NOT NULL,
  witness_generation bigint NOT NULL,
  source_epoch numeric(20,0) NOT NULL CHECK (source_epoch >= 0),
  source_position numeric(20,0) NOT NULL CHECK (source_position >= 0),
  active boolean NOT NULL DEFAULT true,
  ordinal bigint NOT NULL DEFAULT nextval('community.space_discovery_tuple_inverse_key'),
  PRIMARY KEY (tuple_route,source,external_id,field_group,space_route,space_id),
  CHECK (tuple_route BETWEEN 0 AND 65535),
  CHECK (space_route BETWEEN 0 AND 65535),
  CHECK (witness_generation > 0),
  CHECK (ordinal > 0)
);
CREATE INDEX space_discovery_tuple_inverse_page
  ON community.space_discovery_tuple_inverse(tuple_route,source,external_id,field_group,ordinal)
  INCLUDE (space_route,space_id) WHERE active;

-- Keep the existing native inverse and extend its exact-head trigger with an
-- explicit source-provenance witness. A missing witness never means zero tuples.
CREATE OR REPLACE FUNCTION community.refresh_space_discovery_tuple_witness(r integer, id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE current_space_revision uuid; current_realm_id uuid; current_realm_revision uuid;
        current_state text; p integer; next_generation bigint; producer_epoch numeric(20,0);
        source_position numeric(20,0);
BEGIN
  SELECT s.head_revision_id, h.realm_id, h.head_revision_id
    INTO current_space_revision, current_realm_id, current_realm_revision
    FROM community.space s
    LEFT JOIN community.realm h ON h.route=s.route AND h.space_id=s.space_id
    WHERE s.route=r AND s.space_id=id;
  IF NOT FOUND THEN RETURN; END IF;
  p := r / 16;
  SELECT state,producer_epoch,source_position INTO current_state,producer_epoch,source_position
    FROM community.space_discovery_tuple_witness
    WHERE route=r AND space_id=id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO community.space_discovery_tuple_witness
      (route,space_id,space_revision,realm_id,realm_revision,state)
    VALUES(r,id,current_space_revision,current_realm_id,current_realm_revision,'unavailable');
    UPDATE community.space_discovery_tuple_capability
      SET required=required+1,pending=pending+1,cut=cut+1 WHERE partition_no=p;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM community.space_discovery_tuple_witness
    WHERE route=r AND space_id=id
      AND (space_revision IS DISTINCT FROM current_space_revision
        OR realm_id IS DISTINCT FROM current_realm_id
        OR realm_revision IS DISTINCT FROM current_realm_revision)
  ) THEN
    next_generation := nextval('community.space_discovery_tuple_witness_key');
    IF current_state='ready' THEN
      UPDATE community.space_discovery_tuple_capability
        SET witnessed=witnessed-1,pending=pending+1,cut=cut+1 WHERE partition_no=p;
    ELSE
      UPDATE community.space_discovery_tuple_capability
        SET cut=cut+1 WHERE partition_no=p;
    END IF;
    UPDATE community.space_discovery_tuple_witness
      SET witness_generation=next_generation,
          space_revision=current_space_revision,realm_id=current_realm_id,
          realm_revision=current_realm_revision,
          tuple_count=0,state='unavailable'
      WHERE route=r AND space_id=id;
    DELETE FROM community.space_discovery_tuple_expected WHERE route=r AND space_id=id;
    INSERT INTO community.space_discovery_tuple_work
      (route,space_id,witness_generation,tuple_route,source,external_id,field_group,action,producer_epoch,source_position)
    SELECT r,id,next_generation,old.tuple_route,old.source,old.external_id,old.field_group,'remove',
           old.producer_epoch,old.source_position
      FROM (
        SELECT tuple_route,source,external_id,field_group,producer_epoch,source_position
          FROM community.space_discovery_tuple_reference WHERE route=r AND space_id=id
        UNION
        SELECT tuple_route,source,external_id,field_group,producer_epoch,source_position
          FROM community.space_discovery_tuple_work WHERE route=r AND space_id=id
      ) old
    ON CONFLICT DO NOTHING;
    DELETE FROM community.space_discovery_tuple_work WHERE route=r AND space_id=id
      AND witness_generation<>next_generation;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION community.refresh_space_discovery_dependencies(r integer, id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE dependencies jsonb[] := ARRAY[
  '{"kind":"exposure","group":"search"}'::jsonb,
  '{"kind":"exposure","group":"search_advanced"}'::jsonb
]; carried record;
BEGIN
  PERFORM 1 FROM community.space WHERE route=r AND space_id=id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT h.context_id, v.presentation INTO carried
    FROM community.realm h JOIN community.realm_revision v
      ON v.route=h.route AND v.realm_id=h.realm_id AND v.revision_id=h.head_revision_id
    WHERE h.route=r AND h.space_id=id;
  IF FOUND THEN
    dependencies := array_append(dependencies,
      jsonb_build_object('kind','context','id',carried.context_id));
    IF carried.presentation->>'avatarMediaId' IS NOT NULL THEN
      dependencies := array_append(dependencies,
        jsonb_build_object('kind','media','id',carried.presentation->>'avatarMediaId'));
    END IF;
  END IF;
  DELETE FROM community.space_discovery_dependency
    WHERE route=r AND space_id=id AND NOT (dependency=ANY(dependencies));
  INSERT INTO community.space_discovery_dependency(dependency,route,space_id)
    SELECT d,r,id FROM unnest(dependencies) d ON CONFLICT DO NOTHING;
  PERFORM community.refresh_space_discovery_tuple_witness(r,id);
END;
$$;

-- migrate:down
-- Forward only: retain source provenance, inverse tombstones and acknowledgements.
