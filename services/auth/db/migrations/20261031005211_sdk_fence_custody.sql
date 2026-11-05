-- migrate:up
-- Exact native technical receipt in existing Auth receiving progress. The SDK
-- owns permanent writer guards; this migration never changes its schema.
ALTER TABLE auth_copy_work ADD COLUMN sdk_fence_generation text;
ALTER TABLE auth_copy_work ADD COLUMN sdk_fence_closure_id uuid;
ALTER TABLE auth_copy_work ADD COLUMN sdk_fence_closed_at bigint;
ALTER TABLE auth_copy_work ADD COLUMN sdk_fence_pending text CHECK (sdk_fence_pending IN (
  'auth-sdk-permanent-late-writer-fence-unavailable',
  'auth-sdk-native-fence-receipt-mismatch',
  'auth-sdk-original-result-pending',
  'auth-sdk-original-copy-mapping-unavailable',
  'auth-sdk-original-source-pending',
  'auth-sdk-original-consumer-pending',
  'auth-sdk-native-copy-coverage-pending',
  'auth-sdk-physical-copies-pending'
));
ALTER TABLE auth_copy_work ADD CONSTRAINT auth_copy_native_fence CHECK (
  (sdk_fence_generation IS NULL AND sdk_fence_closure_id IS NULL AND sdk_fence_closed_at IS NULL)
  OR (sdk_fence_generation IS NOT NULL AND sdk_fence_generation='2'
    AND sdk_fence_closure_id IS NOT NULL AND sdk_fence_closed_at IS NOT NULL
    AND sdk_fence_closed_at BETWEEN 1 AND 9007199254740991
    AND ready AND result_finished_at IS NOT NULL)
);
CREATE FUNCTION auth_copy_native_fence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.sdk_fence_generation IS NOT NULL THEN
      RAISE EXCEPTION 'Auth native writer receipt is permanent' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.sdk_fence_generation IS NOT NULL AND (
    ROW(NEW.workflow_id,NEW.name,NEW.version,NEW.scope_count,NEW.parent_workflow_id,
      NEW.ready,NEW.source_key,NEW.result_digest,NEW.result_finished_at,NEW.sdk_fence_generation,NEW.sdk_fence_closure_id,NEW.sdk_fence_closed_at)
    IS DISTINCT FROM ROW(OLD.workflow_id,OLD.name,OLD.version,OLD.scope_count,OLD.parent_workflow_id,
      OLD.ready,OLD.source_key,OLD.result_digest,OLD.result_finished_at,OLD.sdk_fence_generation,OLD.sdk_fence_closure_id,OLD.sdk_fence_closed_at)
    OR (OLD.retired AND NOT NEW.retired) OR (OLD.absent AND NOT NEW.absent)) THEN
    RAISE EXCEPTION 'Auth native writer receipt is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.retired AND NOT OLD.retired AND NEW.sdk_fence_generation IS NULL THEN
    RAISE EXCEPTION 'Auth native writer receipt is missing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_copy_native_fence_immutable BEFORE UPDATE OR DELETE ON auth_copy_work
  FOR EACH ROW EXECUTE FUNCTION auth_copy_native_fence_immutable();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Native writer receipt custody is irreversible'; END $$;
