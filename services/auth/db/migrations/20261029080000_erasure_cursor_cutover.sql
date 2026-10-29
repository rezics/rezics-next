-- migrate:up
-- Deploy with issuers/workers quiesced. Resume the bounded deployment step until
-- completed_at is recorded before starting the ordinal writer/worker version.
CREATE SEQUENCE auth_traversal_ordinal;
ALTER TABLE "user" ADD COLUMN traversal_ordinal bigint;
ALTER TABLE auth_consent ADD COLUMN traversal_ordinal bigint;
CREATE UNIQUE INDEX auth_user_ordinal ON "user" (traversal_ordinal) INCLUDE (id);
CREATE UNIQUE INDEX auth_consent_client_ordinal ON auth_consent (client_id, traversal_ordinal) INCLUDE (account_id);

ALTER TABLE auth_client_coverage RENAME COLUMN after_account TO legacy_after_account;
ALTER TABLE auth_client_coverage ALTER COLUMN legacy_after_account DROP NOT NULL;
ALTER TABLE auth_client_coverage ALTER COLUMN legacy_after_account DROP DEFAULT;
ALTER TABLE auth_client_coverage ADD COLUMN after_ordinal bigint NOT NULL DEFAULT 0;
ALTER TABLE auth_client_reduction_progress RENAME COLUMN after_account TO legacy_after_account;
ALTER TABLE auth_client_reduction_progress RENAME COLUMN page_after TO legacy_page_after;
ALTER TABLE auth_client_reduction_progress RENAME COLUMN terminal_account TO legacy_terminal_account;
ALTER TABLE auth_client_reduction_progress ALTER COLUMN legacy_after_account DROP NOT NULL;
ALTER TABLE auth_client_reduction_progress ALTER COLUMN legacy_after_account DROP DEFAULT;
ALTER TABLE auth_client_reduction_progress ALTER COLUMN legacy_page_after DROP NOT NULL;
ALTER TABLE auth_client_reduction_progress ALTER COLUMN legacy_page_after DROP DEFAULT;
ALTER TABLE auth_client_reduction_progress ADD COLUMN after_ordinal bigint NOT NULL DEFAULT 0;
ALTER TABLE auth_client_reduction_progress ADD COLUMN page_after bigint NOT NULL DEFAULT 0;
ALTER TABLE auth_client_reduction_progress ADD COLUMN page_end bigint NOT NULL DEFAULT 0;
ALTER TABLE auth_client_reduction_progress ADD COLUMN terminal_ordinal bigint;
-- Stable restart boundary for legacy DBOS pages whose IDs/inputs used account IDs.
ALTER TABLE auth_client_reduction_progress ADD COLUMN cutover_after bigint;

CREATE TABLE auth_erasure_cursor_cutover (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  writer_version integer NOT NULL DEFAULT 2 CHECK (writer_version = 2),
  phase text NOT NULL CHECK (phase IN ('users','consents','coverage','reduction','done')),
  after_key text,
  after_client text,
  completed_at timestamptz
);
INSERT INTO auth_erasure_cursor_cutover (phase,completed_at)
SELECT CASE WHEN empty THEN 'done' ELSE 'users' END,
       CASE WHEN empty THEN CURRENT_TIMESTAMP END
FROM (SELECT NOT EXISTS (SELECT 1 FROM "user")
         AND NOT EXISTS (SELECT 1 FROM auth_consent)
         AND NOT EXISTS (SELECT 1 FROM auth_client_coverage)
         AND NOT EXISTS (SELECT 1 FROM auth_client_reduction_progress) AS empty) initial;

CREATE FUNCTION auth_require_cursor_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('auth.cursor_backfill',true) IS DISTINCT FROM '2' AND NOT EXISTS
     (SELECT 1 FROM auth_erasure_cursor_cutover WHERE singleton AND completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Auth cursor cutover incomplete; quiesce writers and resume deployment';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME IN ('user','auth_consent') THEN
    IF TG_OP = 'INSERT' THEN NEW.traversal_ordinal := nextval('auth_traversal_ordinal'); END IF;
    IF NEW.traversal_ordinal IS NULL THEN RAISE EXCEPTION 'Auth ordinal required'; END IF;
  ELSE
    IF NEW.legacy_after_account IS NOT NULL THEN RAISE EXCEPTION 'Auth cursor worker version refused'; END IF;
    IF TG_TABLE_NAME = 'auth_client_reduction_progress' THEN
      IF TG_OP = 'UPDATE' AND NEW.completed IS DISTINCT FROM OLD.completed
         AND current_setting('auth.cursor_worker',true) IS DISTINCT FROM '2'
         AND current_setting('auth.cursor_backfill',true) IS DISTINCT FROM '2' THEN
        RAISE EXCEPTION 'Auth cursor worker version refused';
      END IF;
      IF NEW.legacy_page_after IS NOT NULL OR NEW.legacy_terminal_account IS NOT NULL THEN
        RAISE EXCEPTION 'Auth cursor worker version refused';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_user_cursor_version BEFORE INSERT OR UPDATE OR DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION auth_require_cursor_cutover();
CREATE TRIGGER auth_consent_cursor_version BEFORE INSERT OR UPDATE OR DELETE ON auth_consent
  FOR EACH ROW EXECUTE FUNCTION auth_require_cursor_cutover();
CREATE TRIGGER auth_coverage_cursor_version BEFORE INSERT OR UPDATE OR DELETE ON auth_client_coverage
  FOR EACH ROW EXECUTE FUNCTION auth_require_cursor_cutover();
CREATE TRIGGER auth_reduction_cursor_version BEFORE INSERT OR UPDATE OR DELETE ON auth_client_reduction_progress
  FOR EACH ROW EXECUTE FUNCTION auth_require_cursor_cutover();

-- migrate:down
-- Forward only: personal cursor identities cannot be restored after erasure.
