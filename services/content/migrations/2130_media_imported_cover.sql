-- Imported-cover purpose is fixed when its media Asset is born. Ordinary Assets
-- retain their existing shape and need no provenance backfill.
ALTER TABLE media.asset ADD COLUMN cover_only boolean NOT NULL DEFAULT false;
ALTER TABLE media.upload ADD COLUMN imported_cover_intent jsonb;
ALTER TABLE media.upload ADD CONSTRAINT upload_imported_cover_intent_object
  CHECK (imported_cover_intent IS NULL OR jsonb_typeof(imported_cover_intent) = 'object');

CREATE OR REPLACE FUNCTION media.asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.id, OLD.variant_id, OLD.owner, OLD.media_kind, OLD.cover_only,
      OLD.object_namespace, OLD.operation_id, OLD.created_at)
    IS DISTINCT FROM (NEW.id, NEW.variant_id, NEW.owner, NEW.media_kind, NEW.cover_only,
      NEW.object_namespace, NEW.operation_id, NEW.created_at) THEN
    RAISE EXCEPTION 'immutable media asset identity' USING ERRCODE = '23514';
  END IF;
  IF NEW.state_head IS DISTINCT FROM OLD.state_head AND NOT EXISTS (SELECT 1 FROM media.asset_state
      WHERE id = NEW.state_head AND asset_id = NEW.id AND predecessor IS NOT DISTINCT FROM OLD.state_head) THEN
    RAISE EXCEPTION 'media asset state changes only through a state record' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION media.upload_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'reserved' OR NEW.status = 'reserved'
    OR (OLD.id, OLD.asset_id, OLD.principal_id, OLD.operation_id, OLD.erasure_epoch,
      OLD.declared_media_type, OLD.declared_byte_length, OLD.declared_digest,
      OLD.imported_cover_intent, OLD.quarantine_key, OLD.expires_at, OLD.created_at)
    IS DISTINCT FROM (NEW.id, NEW.asset_id, NEW.principal_id, NEW.operation_id, NEW.erasure_epoch,
      NEW.declared_media_type, NEW.declared_byte_length, NEW.declared_digest,
      NEW.imported_cover_intent, NEW.quarantine_key, NEW.expires_at, NEW.created_at) THEN
    RAISE EXCEPTION 'invalid media upload transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'activated' AND NOT EXISTS (SELECT 1 FROM media.representation
      WHERE upload_id = NEW.id AND operation_id = NEW.settle_operation_id) THEN
    RAISE EXCEPTION 'media upload activates only with its representation' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'expired' AND OLD.expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'media upload reservation has not expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION media.reserve_upload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current media.asset_state;
BEGIN
  SELECT s.* INTO current FROM media.asset a
    JOIN media.asset_state s ON s.id = a.state_head WHERE a.id = NEW.asset_id FOR SHARE OF a;
  IF NOT FOUND OR current.lifecycle <> 'active' OR current.erasure_epoch <> NEW.erasure_epoch
    OR NEW.status <> 'reserved' THEN
    RAISE EXCEPTION 'media asset cannot reserve an upload' USING ERRCODE = '23514',
      CONSTRAINT = 'media_activation_fence';
  END IF;
  IF (SELECT cover_only FROM media.asset WHERE id = NEW.asset_id)
      IS DISTINCT FROM (NEW.imported_cover_intent IS NOT NULL) THEN
    RAISE EXCEPTION 'cover-only Assets require provenance on every revision' USING ERRCODE = '23514',
      CONSTRAINT = 'media_cover_upload_purpose';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE media.imported_cover_revision (
  asset_revision_id uuid PRIMARY KEY REFERENCES content.revision(id),
  asset_id uuid NOT NULL REFERENCES media.asset(id),
  original_representation_id uuid NOT NULL,
  original_digest text NOT NULL CHECK (original_digest ~ '^[0-9a-f]{64}$'),
  source_record_id uuid NOT NULL REFERENCES source.record(id) ON DELETE CASCADE,
  source_component text CHECK (source_component IS NULL OR
    source_component ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  observation_id uuid NOT NULL REFERENCES source.observation(id) ON DELETE CASCADE,
  observation_digest text NOT NULL CHECK (observation_digest ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 100),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (asset_id, original_representation_id) REFERENCES media.representation(asset_id, id),
  UNIQUE (original_representation_id)
);

-- These indexes resolve an authorized source record/component or exact
-- observation to revision-pinned originals without scanning the media catalogue.
CREATE INDEX imported_cover_source_record_lookup ON media.imported_cover_revision
  (source_record_id, asset_revision_id)
  INCLUDE (asset_id, original_representation_id, original_digest);
CREATE INDEX imported_cover_source_component_lookup ON media.imported_cover_revision
  (source_component, asset_revision_id)
  INCLUDE (asset_id, original_representation_id, original_digest)
  WHERE source_component IS NOT NULL;
CREATE INDEX imported_cover_observation_lookup ON media.imported_cover_revision
  (observation_id, asset_revision_id)
  INCLUDE (asset_id, original_representation_id, original_digest);
CREATE INDEX imported_cover_original_digest_lookup ON media.imported_cover_revision
  (original_digest, asset_revision_id)
  INCLUDE (asset_id, original_representation_id, source_record_id, observation_id);

CREATE FUNCTION media.check_imported_cover_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content.revision v
    JOIN media.asset a ON a.id = NEW.asset_id
    JOIN media.asset_state s ON s.id = a.state_head
    JOIN media.representation p ON p.id = NEW.original_representation_id AND p.asset_id = a.id
    JOIN media.upload u ON u.id = p.upload_id
    JOIN source.record r ON r.id = NEW.source_record_id
    JOIN source.observation o ON o.id = NEW.observation_id AND o.record_id = r.id
    WHERE v.id = NEW.asset_revision_id AND v.variant_id = a.variant_id
      AND v.model = 'media-asset-v1' AND v.availability = 'available'
      AND v.body->>'profile' = 'media-asset-v1'
      AND v.body->>'asset' = 'https://rezics.com/id/' || a.id::text
      AND v.body->>'coverOnly' = 'true'
      AND v.body->'importedCover' = u.imported_cover_intent
      AND (v.body->'representations') @> jsonb_build_array(jsonb_build_object(
        'id', p.id::text, 'role', 'original', 'sha256', p.byte_digest,
        'byteLength', p.byte_length, 'mediaType', p.media_type))
      AND a.cover_only AND s.lifecycle <> 'erased'
      AND p.kind = 'original' AND p.availability = 'available'
      AND p.byte_digest = NEW.original_digest
      AND u.declared_digest = p.byte_digest AND u.declared_byte_length = p.byte_length
      AND u.declared_media_type = p.media_type
      AND u.imported_cover_intent->>'format' = 'media-imported-cover-v1'
      AND u.imported_cover_intent->'source'->>'record' = 'https://rezics.com/id/' || r.id::text
      AND u.imported_cover_intent->'source'->>'observation' = 'https://rezics.com/id/' || o.id::text
      AND u.imported_cover_intent->'source'->>'provider' = r.provider
      AND u.imported_cover_intent->'source'->>'namespace' = r.namespace
      AND u.imported_cover_intent->'source'->>'externalId' = r.external_id
      AND u.imported_cover_intent->'source'->>'sourceRevision' IS NOT DISTINCT FROM o.source_revision
      AND u.imported_cover_intent->'source'->>'observationDigest' = o.byte_digest
      AND u.imported_cover_intent->'source'->>'observationDigest' = NEW.observation_digest
      AND u.imported_cover_intent->'image'->>'captureDigest' = p.byte_digest
      AND u.imported_cover_intent->>'originalDigest' = p.byte_digest
      AND o.retention = 'retained' AND o.raw_bytes IS NOT NULL
      AND r.id = NEW.source_record_id AND o.record_id = NEW.source_record_id
      AND r.provider = NEW.provider AND r.namespace = NEW.namespace AND r.external_id = NEW.external_id
      AND u.imported_cover_intent->'source'->>'component' IS NOT DISTINCT FROM NEW.source_component
  ) THEN
    RAISE EXCEPTION 'imported cover projection does not match sealed owner evidence' USING ERRCODE = '23514',
      CONSTRAINT = 'imported_cover_revision_basis';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER imported_cover_revision_basis BEFORE INSERT ON media.imported_cover_revision
  FOR EACH ROW EXECUTE FUNCTION media.check_imported_cover_revision();

CREATE FUNCTION media.imported_cover_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'imported cover projection is derived and immutable' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER imported_cover_revision_no_update BEFORE UPDATE ON media.imported_cover_revision
  FOR EACH ROW EXECUTE FUNCTION media.imported_cover_revision_immutable();

CREATE FUNCTION media.clear_imported_cover_for_asset_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle = 'erased' THEN
    DELETE FROM media.imported_cover_revision WHERE asset_id = NEW.asset_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER imported_cover_asset_erasure AFTER INSERT ON media.asset_state
  FOR EACH ROW WHEN (NEW.lifecycle = 'erased')
  EXECUTE FUNCTION media.clear_imported_cover_for_asset_erasure();

CREATE FUNCTION media.clear_imported_cover_for_revision_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.availability IS DISTINCT FROM NEW.availability AND NEW.availability = 'erased' THEN
    DELETE FROM media.imported_cover_revision WHERE asset_revision_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER imported_cover_revision_erasure AFTER UPDATE OF availability ON content.revision
  FOR EACH ROW EXECUTE FUNCTION media.clear_imported_cover_for_revision_erasure();

CREATE FUNCTION media.clear_imported_cover_for_original_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.availability IS DISTINCT FROM NEW.availability AND NEW.availability = 'erased'
    AND NEW.kind = 'original' THEN
    DELETE FROM media.imported_cover_revision WHERE original_representation_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER imported_cover_original_erasure AFTER UPDATE OF availability ON media.representation
  FOR EACH ROW EXECUTE FUNCTION media.clear_imported_cover_for_original_erasure();
