-- migrate:up
-- The UUID locates one real Access cut for this restored generation. It proves
-- neither Source closure nor physical inventory, and is never rotated on retry.
ALTER TABLE auth_restore_generation
  ADD COLUMN source_cut_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN source_cut jsonb CHECK(octet_length(source_cut::text)<=1024),
  ADD COLUMN source_cursor jsonb DEFAULT '{"partition":0,"afterOrdinal":"0"}'::jsonb
    CHECK(octet_length(source_cursor::text)<=128),
  ADD COLUMN source_verify_partition integer NOT NULL DEFAULT 0 CHECK(source_verify_partition BETWEEN 0 AND 4096),
  ADD COLUMN source_revision bigint NOT NULL DEFAULT 0 CHECK(source_revision>=0);

-- Account routes are 16-bit; only feed partitions have a 12-bit domain.
ALTER TABLE auth_erasure DROP CONSTRAINT auth_erasure_source_route_check;
ALTER TABLE auth_erasure ADD CONSTRAINT auth_erasure_source_route_check CHECK(source_route BETWEEN 0 AND 65535);

ALTER TABLE auth_restore_replay ADD COLUMN source_obligation jsonb
  CHECK(octet_length(source_obligation::text)<=1024);
CREATE FUNCTION auth_restore_obligation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_obligation IS NOT NULL AND NEW.source_obligation IS DISTINCT FROM OLD.source_obligation THEN
    RAISE EXCEPTION 'Auth original Source obligation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_restore_obligation_immutable BEFORE UPDATE ON auth_restore_replay
  FOR EACH ROW EXECUTE FUNCTION auth_restore_obligation_immutable();

CREATE FUNCTION auth_restore_cut_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_cut_id IS DISTINCT FROM OLD.source_cut_id
    OR NEW.source_verify_partition < OLD.source_verify_partition
    OR NEW.source_revision < OLD.source_revision THEN
    RAISE EXCEPTION 'Auth native Source cut locator is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_restore_cut_immutable BEFORE UPDATE ON auth_restore_generation
  FOR EACH ROW EXECUTE FUNCTION auth_restore_cut_immutable();

-- Exactly one bounded page and actual verifier observation per native partition.
-- Earlier page obligations/root/floor stay bound to immutable original_progress
-- in auth_restore_replay. This is consumed progress, not a second erasure engine.
CREATE TABLE auth_restore_source_partition (
  generation text NOT NULL REFERENCES auth_restore_generation(generation),
  partition integer NOT NULL CHECK(partition BETWEEN 0 AND 4095),
  page jsonb NOT NULL CHECK(octet_length(page::text)<=65536),
  verification jsonb CHECK(octet_length(verification::text)<=2048),
  PRIMARY KEY(generation,partition)
);

-- migrate:down
-- Forward only: consumed Source identity and original progress cannot be reset.
