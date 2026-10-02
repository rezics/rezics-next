-- Media presentation is an owner-local binding of EditorialFieldTarget and
-- EditorialControlBasis. NSFW evidence never grants or denies byte access.
INSERT INTO content.receipt_action (action) VALUES
  ('media.field.change'), ('media.inference.record') ON CONFLICT DO NOTHING;

ALTER TABLE media.use DROP CONSTRAINT use_role_check;
ALTER TABLE media.use ADD CONSTRAINT use_role_check CHECK (role IN ('avatar','publication-item','document-image'));
ALTER TABLE media.use ADD COLUMN occurrence uuid;
CREATE UNIQUE INDEX document_image_occurrence ON media.use (target, occurrence)
  WHERE role = 'document-image';

CREATE TABLE media.field_slot (
  slot text PRIMARY KEY,
  representation_id uuid REFERENCES media.representation(id),
  use_id uuid REFERENCES media.use(id),
  field text NOT NULL CHECK (field IN ('nsfw','ageRating','conceal')),
  head uuid,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  protection_head uuid,
  value_head uuid,
  CHECK ((field = 'conceal' AND use_id IS NOT NULL AND representation_id IS NULL)
    OR (field IN ('nsfw','ageRating') AND representation_id IS NOT NULL AND use_id IS NULL)),
  UNIQUE (representation_id, field), UNIQUE (use_id, field)
);
CREATE TABLE media.field_revision (
  id uuid PRIMARY KEY,
  slot text NOT NULL REFERENCES media.field_slot(slot),
  predecessor uuid REFERENCES media.field_revision(id),
  epoch bigint NOT NULL CHECK (epoch > 0),
  expected_protection uuid REFERENCES media.field_revision(id),
  expected_value uuid REFERENCES media.field_revision(id),
  mode text NOT NULL CHECK (mode IN ('edit','lock','unlock')),
  source text NOT NULL CHECK (source IN ('author','platform','client','server')),
  value jsonb NOT NULL,
  actor text NOT NULL,
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (slot, epoch)
);
ALTER TABLE media.field_slot ADD FOREIGN KEY (head) REFERENCES media.field_revision(id),
  ADD FOREIGN KEY (protection_head) REFERENCES media.field_revision(id),
  ADD FOREIGN KEY (value_head) REFERENCES media.field_revision(id);
CREATE TRIGGER field_revision_immutable BEFORE UPDATE OR DELETE ON media.field_revision
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE FUNCTION media.apply_field_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_slot media.field_slot;
BEGIN
  SELECT * INTO current_slot FROM media.field_slot WHERE slot = NEW.slot FOR UPDATE;
  IF current_slot.head IS DISTINCT FROM NEW.predecessor
    OR current_slot.epoch + 1 <> NEW.epoch
    OR current_slot.protection_head IS DISTINCT FROM NEW.expected_protection
    OR current_slot.value_head IS DISTINCT FROM NEW.expected_value THEN
    RAISE EXCEPTION 'media field basis changed' USING ERRCODE = '23514';
  END IF;
  IF ((current_slot.protection_head IS NOT NULL OR NEW.mode <> 'edit') AND NEW.source <> 'platform')
    OR (NEW.source IN ('client','server') AND current_slot.value_head IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM content.receipt r WHERE r.operation_id = NEW.operation_id
      AND r.outcome = 'succeeded' AND r.action IN ('media.field.change','media.inference.record')) THEN
    RAISE EXCEPTION 'media field is protected or already assessed' USING ERRCODE = '23514';
  END IF;
  UPDATE media.field_slot SET head = NEW.id, epoch = NEW.epoch,
    value_head = CASE WHEN NEW.mode = 'unlock' THEN value_head ELSE NEW.id END,
    protection_head = CASE WHEN NEW.mode = 'lock' THEN NEW.id WHEN NEW.mode = 'unlock' THEN NULL ELSE protection_head END
    WHERE slot = NEW.slot;
  RETURN NEW;
END $$;
CREATE TRIGGER field_revision_apply AFTER INSERT ON media.field_revision
  FOR EACH ROW EXECUTE FUNCTION media.apply_field_revision();

CREATE TABLE media.inference_observation (
  id uuid PRIMARY KEY,
  representation_id uuid NOT NULL REFERENCES media.representation(id),
  byte_digest text NOT NULL CHECK (byte_digest ~ '^[0-9a-f]{64}$'),
  producer text NOT NULL CHECK (producer IN ('client','server')),
  model text NOT NULL, model_version text NOT NULL, weights_digest text NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed','unavailable')),
  result text NOT NULL CHECK (result IN ('unknown','sfw','nsfw')),
  scores jsonb,
  actor text NOT NULL,
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'unavailable' AND result = 'unknown' AND scores IS NULL)
    OR (status = 'completed' AND result <> 'unknown' AND jsonb_typeof(scores) = 'object'))
);
CREATE INDEX inference_representation ON media.inference_observation (representation_id, created_at DESC, id DESC);
CREATE TRIGGER inference_observation_immutable BEFORE UPDATE OR DELETE ON media.inference_observation
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE FUNCTION media.inference_digest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM media.representation p WHERE p.id = NEW.representation_id
    AND p.byte_digest = NEW.byte_digest AND p.availability = 'available') THEN
    RAISE EXCEPTION 'inference does not match representation bytes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inference_observation_digest BEFORE INSERT ON media.inference_observation
  FOR EACH ROW EXECUTE FUNCTION media.inference_digest_guard();

-- Binary validity, actual staff rejection and known-copy suppression remain
-- independent of presentation. Old classifier holds also stop blocking delivery.
CREATE OR REPLACE FUNCTION media.delivery_clearance(p media.representation) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN media.digest_suppressed(o.byte_digest)
    OR (o.clearance = 'rejected' AND o.clearance_reason = 'staff-rejected')
    THEN 'rejected' ELSE 'cleared' END FROM media.representation o
    WHERE o.id = CASE WHEN p.kind = 'original' THEN p.id ELSE p.source_id END AND o.kind = 'original'
$$;
-- Client-side inference is the launch producer. Retained historical server
-- results remain immutable evidence; no classifier queue gates new originals.
DROP TRIGGER representation_queue_screen ON media.representation;
