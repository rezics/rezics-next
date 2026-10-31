-- migrate:up
-- Preserve durable phase identities 0..61. Phase 62, previously the retry
-- boundary, now starts the appended current-source roles; the new boundary is 74.
-- Old local completion never stands in for coverage of newly integrated stores.
UPDATE access.erasure_native_progress SET native_complete_at=NULL,
  pending='native-inventory' WHERE phase>=62;
ALTER TABLE access.erasure_native_blocked DROP CONSTRAINT erasure_native_blocked_reason_check;
ALTER TABLE access.erasure_native_blocked ADD CONSTRAINT erasure_native_blocked_reason_check
  CHECK (reason IN (
    'handle-consumer',
    'membership-terminal-consumer',
    'organization-close-consumer',
    'verification-decision-consumer',
    'verification-reversal-consumer',
    'controller-transition-consumer',
    'rating-controller-projection-custody',
    'organization-cursor-cutover',
    'rate-binding-deployment-coverage',
    'auth-fence-release-witness-unavailable',
    'continuation-barrier-consumer',
    'deletion-local-consumer',
    'native-terminal-consumer',
    'approval-consumer-proof-unavailable',
    'opening-consumer-proof-unavailable',
    'credential-consumer-proof-unavailable',
    'continuation-child-consumer',
    'operator-page-consumer',
    'terminal-inventory',
    'account-discovery-consumer',
    'verification-source-custody',
    'realm-succession-source-custody'
  ));

CREATE OR REPLACE FUNCTION access.native_terminal_account_ready(value access.account) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT value.state='deleted' AND value.authn_fenced
  AND value.account_id::text=current_setting('rezics.erasure_terminal',true)
  AND EXISTS (SELECT 1 FROM access.erasure e WHERE e.route=value.route AND e.account_id=value.account_id)
  AND EXISTS (SELECT 1 FROM access.erasure_native_progress p WHERE p.route=value.route AND p.account_id=value.account_id
    AND p.progress_id::text=current_setting('rezics.erasure_progress',true)
    -- Original terminal phase 61 runs only after all appended source phases.
    AND p.phase=74
    AND NOT EXISTS (SELECT 1 FROM access.erasure_native_blocked b WHERE b.progress_id=p.progress_id AND b.phase<>61));
$$;

CREATE OR REPLACE FUNCTION access.account_discovery_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; a uuid; v bigint; delta integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.state = 'active' AND NOT OLD.authn_fenced THEN delta := delta - 1; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.state = 'active' AND NOT NEW.authn_fenced THEN delta := delta + 1; END IF;
    r := NEW.route; a := NEW.account_id; v := NEW.discovery_revision;
  ELSE
    r := OLD.route; a := OLD.account_id; v := nextval('access.account_discovery_revision');
  END IF;
  UPDATE access.account_discovery_population SET population = population + delta, revision = v WHERE partition_no = r >> 4;
  IF TG_OP <> 'UPDATE' OR NOT access.native_terminal_account_ready(OLD) THEN
    INSERT INTO access.account_discovery_intent VALUES (r, a, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  IF TG_OP = 'DELETE' OR NEW.state = 'deleted' THEN
    DELETE FROM access.account_discovery_claim_cursor WHERE route = r AND account_id = a;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access.account_discovery_claim_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; v bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD.route; v := nextval('access.account_discovery_revision');
  ELSE r := NEW.route; v := NEW.discovery_revision; END IF;
  UPDATE access.account_discovery_population SET claim_revision = v WHERE partition_no = r >> 4;
  IF TG_OP <> 'INSERT' AND OLD.account_id IS NOT NULL THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, OLD.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.account_id IS NOT NULL THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, NEW.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  RETURN NULL;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Current-source erasure coverage cannot be rolled back'; END $$;
