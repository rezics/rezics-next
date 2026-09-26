-- Media owner state in Main's Content database. Asset revisions and image-only
-- publication bodies are ordinary content.revision rows (models media-asset-v1
-- and media-set-v1), so their anchors, receipts, outbox, pins and erasure states
-- stay in the Content adapter. This schema holds only media identity, workflow
-- and selection state; bytes live in object storage under per-asset namespaces.
CREATE SCHEMA IF NOT EXISTS media;

-- Register media receipt actions (migration 022 owns the action registry).
INSERT INTO content.receipt_action (action) VALUES
  ('media.upload.reserve'), ('media.upload.settle'), ('media.transform.request'),
  ('media.transform.settle'), ('media.asset.state'), ('media.use.create'), ('media.selection.change')
  ON CONFLICT DO NOTHING;

CREATE TABLE media.asset (
  id uuid PRIMARY KEY,
  -- The asset component's Content variant; content.saveDraft creates it with the
  -- first media-asset-v1 revision, so this is a derived key rather than an FK.
  variant_id text NOT NULL UNIQUE,
  owner text NOT NULL CHECK (owner ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  media_kind text NOT NULL CHECK (media_kind = 'image'),
  -- One retention/disclosure domain per asset: no cross-asset deduplication.
  object_namespace text NOT NULL UNIQUE,
  state_head uuid NOT NULL,
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, variant_id),
  CHECK (variant_id = 'urn:rezics:variant:' || id::text),
  CHECK (object_namespace = 'media/asset/' || id::text || '/')
);

CREATE TABLE media.asset_state (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES media.asset(id),
  predecessor uuid,
  disclosure text NOT NULL CHECK (disclosure IN ('private', 'public')),
  moderation text NOT NULL CHECK (moderation IN ('none', 'suppressed')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('active', 'deleted', 'erased')),
  -- Media's local erasure frontier: uploads and transforms bind it at request.
  erasure_epoch bigint NOT NULL CHECK (erasure_epoch >= 0),
  actor text NOT NULL CHECK (actor ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  authority_epoch text NOT NULL CHECK (authority_epoch ~ '^(0|[1-9][0-9]{0,19})$'),
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  data_epoch uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (asset_id, id),
  UNIQUE (data_epoch, sequence),
  FOREIGN KEY (data_epoch, sequence) REFERENCES content.receipt(data_epoch, sequence),
  FOREIGN KEY (asset_id, predecessor) REFERENCES media.asset_state(asset_id, id)
);
ALTER TABLE media.asset ADD CONSTRAINT asset_state_head_fk
  FOREIGN KEY (id, state_head) REFERENCES media.asset_state(asset_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE media.upload (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES media.asset(id),
  principal_id uuid NOT NULL,
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  erasure_epoch bigint NOT NULL CHECK (erasure_epoch >= 0),
  declared_media_type text NOT NULL
    CHECK (declared_media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif')),
  declared_byte_length integer NOT NULL CHECK (declared_byte_length BETWEEN 1 AND 33554432),
  declared_digest text CHECK (declared_digest IS NULL OR declared_digest ~ '^[0-9a-f]{64}$'),
  quarantine_key text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'activated', 'rejected', 'expired')),
  reason text CHECK (reason IS NULL OR reason IN ('size-mismatch', 'digest-mismatch',
    'format-rejected', 'scan-rejected', 'erasure-fenced', 'cancelled')),
  settle_operation_id text UNIQUE REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE (asset_id, id),
  CHECK (quarantine_key = 'media-quarantine/' || id::text),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 day'),
  CHECK ((status = 'reserved' AND reason IS NULL AND settle_operation_id IS NULL AND settled_at IS NULL)
    OR (status = 'activated' AND reason IS NULL AND settle_operation_id IS NOT NULL AND settled_at IS NOT NULL)
    OR (status = 'rejected' AND reason IS NOT NULL AND settle_operation_id IS NOT NULL AND settled_at IS NOT NULL)
    OR (status = 'expired' AND reason IS NULL AND settle_operation_id IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX upload_reserved_expiry_idx ON media.upload (expires_at, id) WHERE status = 'reserved';
CREATE INDEX upload_principal_open_idx ON media.upload (principal_id, id) WHERE status = 'reserved';

CREATE TABLE media.representation (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES media.asset(id),
  kind text NOT NULL CHECK (kind IN ('original', 'rendition')),
  upload_id uuid UNIQUE,
  source_id uuid,
  transform_job_id uuid UNIQUE,
  profile text CHECK (profile IS NULL OR profile ~ '^[a-z][a-z0-9-]{0,62}-v[1-9][0-9]{0,3}$'),
  -- W3C media fragment selector in percent units; the crop is part of a rendition's identity.
  crop text CHECK (crop IS NULL OR crop ~ '^xywh=percent:([0-9]{1,3}(\.[0-9]{1,3})?,){3}[0-9]{1,3}(\.[0-9]{1,3})?$'),
  byte_digest text NOT NULL CHECK (byte_digest ~ '^[0-9a-f]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 33554432),
  media_type text NOT NULL
    CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif')),
  pixel_width integer NOT NULL CHECK (pixel_width BETWEEN 1 AND 16384),
  pixel_height integer NOT NULL CHECK (pixel_height BETWEEN 1 AND 16384),
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'erased', 'unavailable')),
  operation_id text NOT NULL REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (asset_id, id),
  FOREIGN KEY (asset_id, upload_id) REFERENCES media.upload(asset_id, id),
  FOREIGN KEY (asset_id, source_id) REFERENCES media.representation(asset_id, id),
  CHECK ((kind = 'original' AND upload_id IS NOT NULL AND source_id IS NULL
      AND transform_job_id IS NULL AND profile IS NULL AND crop IS NULL)
    OR (kind = 'rendition' AND upload_id IS NULL AND source_id IS NOT NULL
      AND transform_job_id IS NOT NULL AND profile IS NOT NULL))
);
-- One deliverable rendition per exact source/profile/crop; summary hydration probes this key.
CREATE UNIQUE INDEX representation_rendition_idx ON media.representation (source_id, profile, crop)
  NULLS NOT DISTINCT WHERE kind = 'rendition' AND availability = 'available';

CREATE TABLE media.transform_job (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES media.asset(id),
  source_id uuid NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  profile text NOT NULL CHECK (profile ~ '^[a-z][a-z0-9-]{0,62}-v[1-9][0-9]{0,3}$'),
  crop text CHECK (crop IS NULL OR crop ~ '^xywh=percent:([0-9]{1,3}(\.[0-9]{1,3})?,){3}[0-9]{1,3}(\.[0-9]{1,3})?$'),
  authority_epoch text NOT NULL CHECK (authority_epoch ~ '^(0|[1-9][0-9]{0,19})$'),
  erasure_epoch bigint NOT NULL CHECK (erasure_epoch >= 0),
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 16),
  lease_token uuid,
  lease_expires_at timestamptz,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  settle_operation_id text UNIQUE REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE (asset_id, id),
  FOREIGN KEY (asset_id, source_id) REFERENCES media.representation(asset_id, id),
  CHECK ((status = 'queued' AND lease_token IS NULL AND lease_expires_at IS NULL
      AND settle_operation_id IS NULL AND settled_at IS NULL AND reason IS NULL)
    OR (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND settle_operation_id IS NULL AND settled_at IS NULL AND reason IS NULL)
    OR (status = 'succeeded' AND lease_token IS NOT NULL
      AND settle_operation_id IS NOT NULL AND settled_at IS NOT NULL AND reason IS NULL)
    OR (status IN ('failed', 'cancelled')
      AND settle_operation_id IS NOT NULL AND settled_at IS NOT NULL AND reason IS NOT NULL))
);
CREATE UNIQUE INDEX transform_job_live_idx ON media.transform_job (source_id, profile, crop)
  NULLS NOT DISTINCT WHERE status IN ('queued', 'leased');
CREATE INDEX transform_job_queue_idx ON media.transform_job (created_at, id) WHERE status = 'queued';
CREATE INDEX transform_job_lease_idx ON media.transform_job (lease_expires_at, id) WHERE status = 'leased';
ALTER TABLE media.representation ADD CONSTRAINT representation_transform_job_fk
  FOREIGN KEY (asset_id, transform_job_id) REFERENCES media.transform_job(asset_id, id);

-- A Use attaches one exact asset revision/representation basis to a target
-- Resource in a context and role. Publication order lives in the media-set body.
CREATE TABLE media.use (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL,
  asset_variant_id text NOT NULL,
  asset_revision_id uuid NOT NULL,
  representation_id uuid NOT NULL,
  target text NOT NULL CHECK (target ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  context text NOT NULL CHECK (context = 'urn:rezics:media:context:default'
    OR context ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  role text NOT NULL CHECK (role IN ('avatar', 'publication-item')),
  crop text CHECK (crop IS NULL OR crop ~ '^xywh=percent:([0-9]{1,3}(\.[0-9]{1,3})?,){3}[0-9]{1,3}(\.[0-9]{1,3})?$'),
  actor text NOT NULL CHECK (actor ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  operation_id text NOT NULL REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, target, context, role),
  FOREIGN KEY (asset_id, asset_variant_id) REFERENCES media.asset(id, variant_id),
  FOREIGN KEY (asset_variant_id, asset_revision_id) REFERENCES content.revision(variant_id, id),
  FOREIGN KEY (asset_id, representation_id) REFERENCES media.representation(asset_id, id)
);
CREATE INDEX use_target_idx ON media.use (target, role, context, created_at, id);
CREATE INDEX use_asset_idx ON media.use (asset_id, id);

CREATE TABLE media.selection_slot (
  target text NOT NULL CHECK (target ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  context text NOT NULL CHECK (context = 'urn:rezics:media:context:default'
    OR context ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  role text NOT NULL CHECK (role = 'avatar'),
  policy text NOT NULL CHECK (policy = 'avatar-selection-v1'),
  -- Absent head: never selected. A head whose use is NULL: explicit removal.
  head uuid,
  PRIMARY KEY (target, context, role)
);

CREATE TABLE media.selection_revision (
  id uuid PRIMARY KEY,
  target text NOT NULL,
  context text NOT NULL,
  role text NOT NULL,
  predecessor uuid,
  use_id uuid,
  actor text NOT NULL CHECK (actor ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  authority_epoch text NOT NULL CHECK (authority_epoch ~ '^(0|[1-9][0-9]{0,19})$'),
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  data_epoch uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (target, context, role, id),
  UNIQUE (data_epoch, sequence),
  FOREIGN KEY (data_epoch, sequence) REFERENCES content.receipt(data_epoch, sequence),
  FOREIGN KEY (target, context, role) REFERENCES media.selection_slot(target, context, role),
  FOREIGN KEY (target, context, role, predecessor) REFERENCES media.selection_revision(target, context, role, id),
  FOREIGN KEY (use_id, target, context, role) REFERENCES media.use(id, target, context, role)
);
ALTER TABLE media.selection_slot ADD CONSTRAINT selection_slot_head_fk
  FOREIGN KEY (target, context, role, head) REFERENCES media.selection_revision(target, context, role, id);

-- Immutable records reuse Content's mutation guard.
CREATE TRIGGER asset_state_immutable BEFORE UPDATE OR DELETE ON media.asset_state
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE TRIGGER use_immutable BEFORE UPDATE OR DELETE ON media.use
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE TRIGGER selection_revision_immutable BEFORE UPDATE OR DELETE ON media.selection_revision
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();

CREATE FUNCTION media.asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.id, OLD.variant_id, OLD.owner, OLD.media_kind, OLD.object_namespace,
      OLD.operation_id, OLD.created_at)
    IS DISTINCT FROM (NEW.id, NEW.variant_id, NEW.owner, NEW.media_kind, NEW.object_namespace,
      NEW.operation_id, NEW.created_at) THEN
    RAISE EXCEPTION 'immutable media asset identity' USING ERRCODE = '23514';
  END IF;
  -- The head moves only to a recorded successor of the current head.
  IF NEW.state_head IS DISTINCT FROM OLD.state_head AND NOT EXISTS (SELECT 1 FROM media.asset_state
      WHERE id = NEW.state_head AND asset_id = NEW.id AND predecessor IS NOT DISTINCT FROM OLD.state_head) THEN
    RAISE EXCEPTION 'media asset state changes only through a state record' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_identity_immutable BEFORE UPDATE OR DELETE ON media.asset
  FOR EACH ROW EXECUTE FUNCTION media.asset_guard();

-- The state head is the asset's disclosure/lifecycle CAS: a successor must name
-- the current head, erased is terminal and deletion/erasure advance the epoch.
CREATE FUNCTION media.check_asset_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head uuid; prior media.asset_state;
BEGIN
  SELECT state_head INTO head FROM media.asset WHERE id = NEW.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media asset is absent' USING ERRCODE = '23503';
  END IF;
  IF NEW.predecessor IS NULL THEN
    IF head IS DISTINCT FROM NEW.id OR EXISTS (SELECT 1 FROM media.asset_state WHERE asset_id = NEW.asset_id)
      OR NEW.lifecycle <> 'active' OR NEW.moderation <> 'none' OR NEW.erasure_epoch <> 0 THEN
      RAISE EXCEPTION 'invalid initial media asset state' USING ERRCODE = '23514',
        CONSTRAINT = 'media_asset_state_head';
    END IF;
    RETURN NEW;
  END IF;
  IF head IS DISTINCT FROM NEW.predecessor THEN
    RAISE EXCEPTION 'media asset state head has changed' USING ERRCODE = '23514',
      CONSTRAINT = 'media_asset_state_head';
  END IF;
  SELECT * INTO STRICT prior FROM media.asset_state WHERE id = NEW.predecessor;
  IF prior.lifecycle = 'erased' OR NEW.erasure_epoch < prior.erasure_epoch
    OR (NEW.lifecycle IN ('deleted', 'erased') AND NEW.lifecycle <> prior.lifecycle
      AND NEW.erasure_epoch <= prior.erasure_epoch)
    OR (NEW.lifecycle = prior.lifecycle AND NEW.erasure_epoch <> prior.erasure_epoch) THEN
    RAISE EXCEPTION 'invalid media asset lifecycle transition' USING ERRCODE = '23514',
      CONSTRAINT = 'media_asset_lifecycle';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_state_check BEFORE INSERT ON media.asset_state
  FOR EACH ROW EXECUTE FUNCTION media.check_asset_state();
CREATE FUNCTION media.advance_asset_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.predecessor IS NOT NULL THEN
    UPDATE media.asset SET state_head = NEW.id WHERE id = NEW.asset_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_state_advance AFTER INSERT ON media.asset_state
  FOR EACH ROW EXECUTE FUNCTION media.advance_asset_state();

CREATE FUNCTION media.upload_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'reserved' OR NEW.status = 'reserved'
    OR (OLD.id, OLD.asset_id, OLD.principal_id, OLD.operation_id, OLD.erasure_epoch,
      OLD.declared_media_type, OLD.declared_byte_length, OLD.declared_digest,
      OLD.quarantine_key, OLD.expires_at, OLD.created_at)
    IS DISTINCT FROM (NEW.id, NEW.asset_id, NEW.principal_id, NEW.operation_id, NEW.erasure_epoch,
      NEW.declared_media_type, NEW.declared_byte_length, NEW.declared_digest,
      NEW.quarantine_key, NEW.expires_at, NEW.created_at) THEN
    RAISE EXCEPTION 'invalid media upload transition' USING ERRCODE = '23514';
  END IF;
  -- Only its representation activates a reservation; expiry needs the reservation to lapse.
  IF NEW.status = 'activated' AND NOT EXISTS (SELECT 1 FROM media.representation
      WHERE upload_id = NEW.id AND operation_id = NEW.settle_operation_id) THEN
    RAISE EXCEPTION 'media upload activates only with its representation' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'expired' AND OLD.expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'media upload reservation has not expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER upload_monotone BEFORE UPDATE OR DELETE ON media.upload
  FOR EACH ROW EXECUTE FUNCTION media.upload_guard();
CREATE FUNCTION media.reserve_upload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current media.asset_state;
BEGIN
  SELECT s.* INTO current FROM media.asset a
    JOIN media.asset_state s ON s.id = a.state_head WHERE a.id = NEW.asset_id FOR SHARE OF a;
  IF NOT FOUND OR current.lifecycle <> 'active' OR current.erasure_epoch <> NEW.erasure_epoch
    OR NEW.status <> 'reserved' THEN
    RAISE EXCEPTION 'media asset cannot reserve an upload' USING ERRCODE = '23514',
      CONSTRAINT = 'media_activation_fence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER upload_reserve BEFORE INSERT ON media.upload
  FOR EACH ROW EXECUTE FUNCTION media.reserve_upload();

CREATE FUNCTION media.transform_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current media.asset_state;
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('succeeded', 'failed', 'cancelled')
    OR (OLD.id, OLD.asset_id, OLD.source_id, OLD.input_digest, OLD.profile, OLD.crop,
      OLD.authority_epoch, OLD.erasure_epoch, OLD.operation_id, OLD.created_at)
    IS DISTINCT FROM (NEW.id, NEW.asset_id, NEW.source_id, NEW.input_digest, NEW.profile, NEW.crop,
      NEW.authority_epoch, NEW.erasure_epoch, NEW.operation_id, NEW.created_at) THEN
    RAISE EXCEPTION 'invalid media transform transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'leased' THEN
    -- A new lease replaces only an expired one and always rotates the fence token.
    IF NEW.attempt <> OLD.attempt + 1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
      OR (OLD.status = 'leased' AND OLD.lease_expires_at > clock_timestamp())
      OR NEW.lease_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'media transform lease is held' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'succeeded' THEN
    SELECT s.* INTO STRICT current FROM media.asset a
      JOIN media.asset_state s ON s.id = a.state_head WHERE a.id = NEW.asset_id FOR SHARE OF a;
    IF OLD.status <> 'leased' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
      OR NEW.attempt <> OLD.attempt OR OLD.lease_expires_at <= clock_timestamp()
      OR current.lifecycle <> 'active' OR current.erasure_epoch <> NEW.erasure_epoch THEN
      RAISE EXCEPTION 'stale media transform cannot activate' USING ERRCODE = '23514',
        CONSTRAINT = 'media_transform_fence';
    END IF;
  ELSIF NEW.status = 'queued' OR NEW.attempt <> OLD.attempt
    OR NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
    RAISE EXCEPTION 'invalid media transform transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transform_job_monotone BEFORE UPDATE OR DELETE ON media.transform_job
  FOR EACH ROW EXECUTE FUNCTION media.transform_job_guard();
-- A request binds the exact available source bytes at the current erasure epoch.
CREATE FUNCTION media.request_transform() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current media.asset_state;
BEGIN
  SELECT s.* INTO current FROM media.asset a
    JOIN media.asset_state s ON s.id = a.state_head WHERE a.id = NEW.asset_id FOR SHARE OF a;
  IF NOT FOUND OR current.lifecycle <> 'active' OR current.erasure_epoch <> NEW.erasure_epoch
    OR NEW.status <> 'queued' OR NEW.attempt <> 0 OR NOT EXISTS (SELECT 1 FROM media.representation
      WHERE id = NEW.source_id AND asset_id = NEW.asset_id AND byte_digest = NEW.input_digest
        AND availability = 'available') THEN
    RAISE EXCEPTION 'media transform request lacks an exact current source' USING ERRCODE = '23514',
      CONSTRAINT = 'media_transform_fence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transform_job_request BEFORE INSERT ON media.transform_job
  FOR EACH ROW EXECUTE FUNCTION media.request_transform();

-- Activation fences: an original consumes its unexpired reservation at the
-- current erasure epoch; a rendition needs the exact job settlement for its bytes.
CREATE FUNCTION media.activate_representation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current media.asset_state; upload media.upload; job media.transform_job;
  source media.representation;
BEGIN
  SELECT s.* INTO current FROM media.asset a
    JOIN media.asset_state s ON s.id = a.state_head WHERE a.id = NEW.asset_id FOR SHARE OF a;
  IF NOT FOUND OR current.lifecycle <> 'active' OR NEW.availability <> 'available' THEN
    RAISE EXCEPTION 'media asset cannot activate bytes' USING ERRCODE = '23514',
      CONSTRAINT = 'media_activation_fence';
  END IF;
  IF NEW.kind = 'original' THEN
    SELECT * INTO upload FROM media.upload WHERE id = NEW.upload_id AND asset_id = NEW.asset_id FOR UPDATE;
    IF NOT FOUND OR upload.status <> 'reserved' OR upload.expires_at <= clock_timestamp()
      OR upload.erasure_epoch <> current.erasure_epoch
      OR upload.declared_byte_length <> NEW.byte_length
      OR upload.declared_media_type <> NEW.media_type
      OR (upload.declared_digest IS NOT NULL AND upload.declared_digest <> NEW.byte_digest) THEN
      RAISE EXCEPTION 'media upload does not admit these bytes' USING ERRCODE = '23514',
        CONSTRAINT = 'media_activation_fence';
    END IF;
  ELSE
    SELECT * INTO job FROM media.transform_job WHERE id = NEW.transform_job_id AND asset_id = NEW.asset_id;
    SELECT * INTO source FROM media.representation WHERE id = NEW.source_id AND asset_id = NEW.asset_id;
    IF job.id IS NULL OR source.id IS NULL OR job.status <> 'succeeded'
      OR job.settle_operation_id IS DISTINCT FROM NEW.operation_id
      OR job.source_id <> NEW.source_id OR job.profile <> NEW.profile
      OR job.crop IS DISTINCT FROM NEW.crop OR job.input_digest <> source.byte_digest
      OR source.availability <> 'available' OR job.erasure_epoch <> current.erasure_epoch THEN
      RAISE EXCEPTION 'media rendition lacks its exact transform settlement' USING ERRCODE = '23514',
        CONSTRAINT = 'media_activation_fence';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER representation_activate BEFORE INSERT ON media.representation
  FOR EACH ROW EXECUTE FUNCTION media.activate_representation();
CREATE FUNCTION media.settle_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE media.upload SET status = 'activated', settle_operation_id = NEW.operation_id,
    settled_at = clock_timestamp() WHERE id = NEW.upload_id;
  RETURN NEW;
END $$;
CREATE TRIGGER representation_settles_upload AFTER INSERT ON media.representation
  FOR EACH ROW WHEN (NEW.kind = 'original') EXECUTE FUNCTION media.settle_upload();

-- Bytes are immutable; availability only moves away from available for erasure/loss.
CREATE FUNCTION media.representation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.availability <> 'available' OR NEW.availability = 'available'
    OR (OLD.id, OLD.asset_id, OLD.kind, OLD.upload_id, OLD.source_id, OLD.transform_job_id,
      OLD.profile, OLD.crop, OLD.byte_digest, OLD.byte_length, OLD.media_type,
      OLD.pixel_width, OLD.pixel_height, OLD.operation_id, OLD.created_at)
    IS DISTINCT FROM (NEW.id, NEW.asset_id, NEW.kind, NEW.upload_id, NEW.source_id, NEW.transform_job_id,
      NEW.profile, NEW.crop, NEW.byte_digest, NEW.byte_length, NEW.media_type,
      NEW.pixel_width, NEW.pixel_height, NEW.operation_id, NEW.created_at) THEN
    RAISE EXCEPTION 'immutable media representation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER representation_immutable BEFORE UPDATE OR DELETE ON media.representation
  FOR EACH ROW EXECUTE FUNCTION media.representation_guard();

-- A Use's basis must be an available media-asset-v1 revision that lists the
-- exact representation and digest of an active asset.
CREATE FUNCTION media.use_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE digest text; lifecycle text;
BEGIN
  SELECT r.byte_digest, s.lifecycle INTO digest, lifecycle FROM media.representation r
    JOIN media.asset a ON a.id = r.asset_id JOIN media.asset_state s ON s.id = a.state_head
    WHERE r.id = NEW.representation_id AND r.asset_id = NEW.asset_id AND r.availability = 'available'
    FOR SHARE OF a;
  IF NOT FOUND OR lifecycle <> 'active' OR NOT EXISTS (SELECT 1 FROM content.revision
      WHERE id = NEW.asset_revision_id AND variant_id = NEW.asset_variant_id
        AND model = 'media-asset-v1' AND availability = 'available'
        AND body @> jsonb_build_object('asset', 'https://rezics.com/id/' || NEW.asset_id::text,
          'representations', jsonb_build_array(jsonb_build_object(
            'id', NEW.representation_id::text, 'sha256', digest)))) THEN
    RAISE EXCEPTION 'media use basis is not an exact available asset revision' USING ERRCODE = '23514',
      CONSTRAINT = 'media_use_basis';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER use_basis BEFORE INSERT ON media.use
  FOR EACH ROW EXECUTE FUNCTION media.use_basis_guard();

CREATE FUNCTION media.slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.target, OLD.context, OLD.role, OLD.policy)
      IS DISTINCT FROM (NEW.target, NEW.context, NEW.role, NEW.policy)
    OR (NEW.head IS DISTINCT FROM OLD.head AND NOT EXISTS (SELECT 1 FROM media.selection_revision r
      WHERE r.id = NEW.head AND (r.target, r.context, r.role) = (NEW.target, NEW.context, NEW.role)
        AND r.predecessor IS NOT DISTINCT FROM OLD.head)) THEN
    RAISE EXCEPTION 'media selection slot changes only through a selection revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER selection_slot_guard BEFORE UPDATE OR DELETE ON media.selection_slot
  FOR EACH ROW EXECUTE FUNCTION media.slot_guard();

-- Selection CAS: the new revision names the current head (NULL when never selected).
CREATE FUNCTION media.advance_selection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head uuid;
BEGIN
  SELECT s.head INTO head FROM media.selection_slot s
    WHERE (s.target, s.context, s.role) = (NEW.target, NEW.context, NEW.role) FOR UPDATE;
  IF NOT FOUND OR head IS DISTINCT FROM NEW.predecessor THEN
    RAISE EXCEPTION 'media selection head has changed' USING ERRCODE = '23514',
      CONSTRAINT = 'media_selection_head';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER selection_revision_cas BEFORE INSERT ON media.selection_revision
  FOR EACH ROW EXECUTE FUNCTION media.advance_selection();
CREATE FUNCTION media.settle_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE media.selection_slot SET head = NEW.id
    WHERE (target, context, role) = (NEW.target, NEW.context, NEW.role);
  RETURN NEW;
END $$;
CREATE TRIGGER selection_revision_head AFTER INSERT ON media.selection_revision
  FOR EACH ROW EXECUTE FUNCTION media.settle_selection();
