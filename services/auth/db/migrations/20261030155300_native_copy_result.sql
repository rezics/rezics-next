-- migrate:up
-- The native executor's exact result commitment outlives request/stage cleanup.
-- No return payload, exception, approval or actor identity is retained here.
ALTER TABLE auth_copy_work ADD COLUMN source_key text CHECK(octet_length(source_key)<=256);
ALTER TABLE auth_copy_work ADD COLUMN result_digest bytea CHECK(octet_length(result_digest)=32);
ALTER TABLE auth_copy_work ADD COLUMN result_finished_at timestamptz;
ALTER TABLE auth_copy_work ADD CONSTRAINT auth_copy_result_source
  CHECK ((result_digest IS NULL) = (result_finished_at IS NULL));
CREATE FUNCTION auth_copy_result_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.retired AND NEW.absent AND NEW.source_key IS NULL AND
    (NEW.result_digest IS NULL OR NEW.result_digest=decode(repeat('00',32),'hex')) AND
    NEW.result_finished_at IS NOT DISTINCT FROM OLD.result_finished_at THEN RETURN NEW; END IF;
  IF NEW.source_key IS DISTINCT FROM OLD.source_key OR (OLD.result_finished_at IS NOT NULL AND
    (NEW.result_finished_at IS DISTINCT FROM OLD.result_finished_at OR NEW.result_digest IS DISTINCT FROM OLD.result_digest)) THEN
    RAISE EXCEPTION 'Auth native result commitment is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_copy_result_immutable BEFORE UPDATE ON auth_copy_work
  FOR EACH ROW EXECUTE FUNCTION auth_copy_result_immutable();

-- migrate:down
-- Forward only: native completion cannot be reopened by history loss.
