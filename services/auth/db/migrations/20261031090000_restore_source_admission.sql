-- migrate:up
-- Database/deployment identity is verified by its trusted owner, never generated
-- from startup time. This record proves neither backup custody nor Source EOF.
CREATE TABLE auth_restore_generation (
  generation text PRIMARY KEY CHECK(octet_length(generation) BETWEEN 1 AND 1024),
  inventory jsonb CHECK(octet_length(inventory::text)<=16384),
  native_coverage_started boolean NOT NULL DEFAULT false,
  CHECK(NOT native_coverage_started OR inventory IS NOT NULL)
);
CREATE FUNCTION auth_restore_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.generation IS DISTINCT FROM OLD.generation
    OR (OLD.inventory IS NOT NULL AND NEW.inventory IS DISTINCT FROM OLD.inventory)
    OR (OLD.native_coverage_started AND NOT NEW.native_coverage_started) THEN
    RAISE EXCEPTION 'Auth restore identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_restore_identity_immutable BEFORE UPDATE OR DELETE ON auth_restore_generation
  FOR EACH ROW EXECUTE FUNCTION auth_restore_identity_immutable();

ALTER TABLE auth_erasure ADD COLUMN source_route integer CHECK(source_route BETWEEN 0 AND 4095);
ALTER TABLE auth_erasure ADD COLUMN original_native_id text CHECK(octet_length(original_native_id) BETWEEN 1 AND 1024);
CREATE FUNCTION auth_restore_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.source_route IS NOT NULL AND NEW.source_route IS DISTINCT FROM OLD.source_route)
    OR (OLD.original_native_id IS NOT NULL AND NEW.original_native_id IS DISTINCT FROM OLD.original_native_id)
    OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
    OR (OLD.user_deleted_at IS NOT NULL AND NEW.user_deleted_at IS DISTINCT FROM OLD.user_deleted_at)
    OR (OLD.consent_due_at IS NOT NULL AND NEW.consent_due_at IS DISTINCT FROM OLD.consent_due_at)
    OR (OLD.consent_completed_at IS NOT NULL AND NEW.consent_completed_at IS DISTINCT FROM OLD.consent_completed_at)
    OR (OLD.applicable AND NOT NEW.applicable) THEN
    RAISE EXCEPTION 'Auth restored source evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_restore_source_immutable BEFORE UPDATE ON auth_erasure
  FOR EACH ROW EXECUTE FUNCTION auth_restore_source_immutable();

-- Per-generation cursors for the EXISTING native engine. Source acceptance,
-- consent cutoff and original source completion remain on auth_erasure.
CREATE TABLE auth_restore_replay (
  generation text NOT NULL REFERENCES auth_restore_generation(generation),
  obligation_id bigint NOT NULL REFERENCES auth_erasure(id),
  original_progress jsonb NOT NULL CHECK(octet_length(original_progress::text)<=16384),
  phase integer NOT NULL DEFAULT 0,
  after_key text NOT NULL DEFAULT '' CHECK(octet_length(after_key)<=1024),
  client_id text CHECK(octet_length(client_id)<=1024),
  client_phase integer NOT NULL DEFAULT 0,
  user_replayed boolean NOT NULL DEFAULT false,
  native_completed_at timestamptz,
  consent_completed_at timestamptz,
  copies_completed_at timestamptz,
  pending_code text NOT NULL DEFAULT 'native',
  PRIMARY KEY(generation,obligation_id)
);
CREATE FUNCTION auth_restore_replay_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id OR NEW.original_progress IS DISTINCT FROM OLD.original_progress
    OR (OLD.user_replayed AND NOT NEW.user_replayed)
    OR (OLD.native_completed_at IS NOT NULL AND NEW.native_completed_at IS DISTINCT FROM OLD.native_completed_at)
    OR (OLD.consent_completed_at IS NOT NULL AND NEW.consent_completed_at IS DISTINCT FROM OLD.consent_completed_at)
    OR (OLD.copies_completed_at IS NOT NULL AND NEW.copies_completed_at IS DISTINCT FROM OLD.copies_completed_at) THEN
    RAISE EXCEPTION 'Auth restore replay evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_restore_replay_immutable BEFORE UPDATE OR DELETE ON auth_restore_replay
  FOR EACH ROW EXECUTE FUNCTION auth_restore_replay_immutable();

-- migrate:down
-- Forward only: restore identities and replay fences cannot be forgotten.
