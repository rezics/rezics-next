-- One immutable private proof per dispatchable governance vote command,
-- committed with its access.admission row (the 027 pattern). The admission's
-- claim/seal columns remain the only cross-store operation receipt used for
-- GOV22 reconciliation; Jena owns the resulting poll, allocation, proxy, ballot,
-- approval and resolution facts. Each poll has one Access scope gate,
-- 'vote:poll:<uuid>', which is its authority fence.
CREATE TABLE access.vote_admission (
  admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
  operation text NOT NULL CHECK (operation IN (
    'poll.prepare', 'poll.open', 'poll.close', 'resolution.finalize', 'ballot.invalidate',
    'allocation.activate', 'proxy.designate', 'proxy.revoke',
    'ballot.cast', 'ballot.withdraw', 'ballot.approve')),
  poll text NOT NULL
    CHECK (poll ~ '^https://rezics\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  body_subject text NOT NULL REFERENCES access.authority_subject(id),
  holder_subject text REFERENCES access.authority_subject(id),
  proxy_subject text REFERENCES access.authority_subject(id),
  seat text CHECK (seat ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  source_entitlement text CHECK (source_entitlement ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  authority_path text NOT NULL CHECK (authority_path IN ('holder-mandate', 'proxy-mandate', 'body-grant')),
  representation_id uuid NOT NULL REFERENCES access.representation(id),
  representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
  grant_id uuid REFERENCES access.permission_grant(id),
  grant_generation bigint CHECK (grant_generation >= 0),
  policy_id uuid,
  policy_revision bigint,
  principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
  acting_subject_generation bigint NOT NULL CHECK (acting_subject_generation >= 0),
  -- Exact digest of the candidate effect: ballot choice/distribution, approval,
  -- allocation plan, proxy route, snapshot, opening, invalidation or resolution.
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  -- Expected Jena head for the guarded write; NULL is an explicit absent head.
  expected_head text CHECK (expected_head ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (policy_id, policy_revision)
    REFERENCES access.vote_representative_policy_revision(policy_id, revision),
  CHECK ((grant_id IS NULL) = (grant_generation IS NULL)),
  CHECK ((policy_id IS NULL) = (policy_revision IS NULL)),
  CHECK (proxy_subject IS NULL OR proxy_subject <> holder_subject),
  CHECK (CASE
    WHEN operation IN ('ballot.cast', 'ballot.withdraw') THEN
      authority_path IN ('holder-mandate', 'proxy-mandate') AND grant_id IS NULL
      AND holder_subject IS NOT NULL AND seat IS NOT NULL AND source_entitlement IS NOT NULL
      AND (proxy_subject IS NOT NULL) = (authority_path = 'proxy-mandate')
    WHEN operation = 'ballot.approve' THEN
      authority_path = 'holder-mandate' AND grant_id IS NULL AND proxy_subject IS NULL
      AND holder_subject IS NOT NULL AND seat IS NOT NULL AND source_entitlement IS NOT NULL
      AND policy_id IS NOT NULL
    WHEN operation = 'allocation.activate' THEN
      authority_path = 'holder-mandate' AND grant_id IS NULL AND proxy_subject IS NULL
      AND holder_subject IS NOT NULL AND seat IS NULL AND source_entitlement IS NOT NULL
      AND policy_id IS NULL
    WHEN operation IN ('proxy.designate', 'proxy.revoke') THEN
      authority_path = 'holder-mandate' AND grant_id IS NULL AND proxy_subject IS NOT NULL
      AND holder_subject IS NOT NULL AND seat IS NOT NULL AND source_entitlement IS NOT NULL
      AND policy_id IS NULL
    WHEN operation = 'ballot.invalidate' THEN
      authority_path = 'body-grant' AND grant_id IS NOT NULL AND proxy_subject IS NULL
      AND holder_subject IS NOT NULL AND seat IS NOT NULL AND source_entitlement IS NOT NULL
      AND policy_id IS NULL
    ELSE
      authority_path = 'body-grant' AND grant_id IS NOT NULL AND holder_subject IS NULL
      AND proxy_subject IS NULL AND seat IS NULL AND source_entitlement IS NULL
      AND policy_id IS NULL
  END)
);
CREATE INDEX vote_admission_poll_seat ON access.vote_admission (poll, seat, created_at, admission_id);
CREATE INDEX vote_admission_representation_fk ON access.vote_admission (representation_id);
CREATE INDEX vote_admission_grant_fk ON access.vote_admission (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX vote_admission_policy_fk ON access.vote_admission (policy_id, policy_revision)
  WHERE policy_id IS NOT NULL;
CREATE INDEX vote_admission_body_fk ON access.vote_admission (body_subject);
CREATE INDEX vote_admission_holder_fk ON access.vote_admission (holder_subject)
  WHERE holder_subject IS NOT NULL;
CREATE INDEX vote_admission_proxy_fk ON access.vote_admission (proxy_subject)
  WHERE proxy_subject IS NOT NULL;
CREATE TRIGGER vote_admission_immutable BEFORE UPDATE OR DELETE
  ON access.vote_admission FOR EACH ROW EXECUTE FUNCTION access.reject_vote_record_mutation();

-- The proof names its admission's exact action, poll gate, acting Agent,
-- principal and selected mandate/grant. Casting, seat management, poll
-- administration and invalidation are separately authorized actions.
CREATE FUNCTION access.vote_admission_action(operation text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN operation IN ('ballot.cast', 'ballot.withdraw', 'ballot.approve') THEN 'governance.ballot.operate'
    WHEN operation IN ('allocation.activate', 'proxy.designate', 'proxy.revoke') THEN 'governance.seat.manage'
    WHEN operation = 'ballot.invalidate' THEN 'governance.ballot.invalidate'
    ELSE 'governance.poll.administer'
  END
$$;

CREATE FUNCTION access.check_vote_admission_proof() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acting text := CASE NEW.authority_path WHEN 'holder-mandate' THEN NEW.holder_subject
    WHEN 'proxy-mandate' THEN NEW.proxy_subject END;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM access.admission a
    JOIN access.representation r ON r.id = NEW.representation_id
    WHERE a.id = NEW.admission_id
      AND a.action = access.vote_admission_action(NEW.operation)
      AND a.scope_id = 'vote:poll:' || right(NEW.poll, 36)
      AND a.principal_id = r.principal_id
      AND a.acting_subject = r.subject_id
      AND r.action = a.action
      AND (acting IS NULL OR a.acting_subject = acting)
      AND (r.action <> 'governance.ballot.operate' OR r.resource_subject = NEW.body_subject)
  ) OR (NEW.grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM access.permission_grant g JOIN access.admission a ON a.id = NEW.admission_id
    WHERE g.id = NEW.grant_id AND g.issuer_subject = NEW.body_subject
      AND g.recipient_subject = a.acting_subject AND g.action = a.action
  )) OR (NEW.policy_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM access.vote_representative_policy p
    WHERE p.id = NEW.policy_id AND p.holder_subject = NEW.holder_subject
      AND p.body_subject = NEW.body_subject
  )) THEN
    RAISE EXCEPTION 'vote admission proof must bind its exact admission and authority' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vote_admission_exact_proof BEFORE INSERT ON access.vote_admission
  FOR EACH ROW EXECUTE FUNCTION access.check_vote_admission_proof();

-- Even a writer bug cannot commit a governance vote admission without its
-- proof. Deferral permits inserting both rows in the same owner transaction.
CREATE FUNCTION access.require_vote_admission_proof() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM access.vote_admission v WHERE v.admission_id = NEW.id) THEN
    RAISE EXCEPTION 'governance vote admission requires exact atomic proof' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER vote_admission_bound
  AFTER INSERT OR UPDATE ON access.admission DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.action IN ('governance.ballot.operate', 'governance.seat.manage',
    'governance.poll.administer', 'governance.ballot.invalidate'))
  EXECUTE FUNCTION access.require_vote_admission_proof();
