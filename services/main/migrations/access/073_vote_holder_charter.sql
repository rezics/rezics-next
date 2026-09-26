-- GOV16/GOV17: a holder adopts its casting charter (mandate rule, k-of-n
-- threshold, aggregation mode) for one source entitlement of a draft poll. It is
-- seat management by the holder, separate from casting, and freezes at opening.
DO $$
DECLARE name text;
BEGIN
  FOR name IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'access.vote_admission'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) LIKE '%CASE%' OR conname = 'vote_admission_operation_check')
  LOOP
    EXECUTE format('ALTER TABLE access.vote_admission DROP CONSTRAINT %I', name);
  END LOOP;
END $$;

ALTER TABLE access.vote_admission ADD CONSTRAINT vote_admission_operation_check CHECK (operation IN (
  'poll.prepare', 'poll.open', 'poll.close', 'resolution.finalize', 'ballot.invalidate',
  'allocation.activate', 'holder-charter.set', 'proxy.designate', 'proxy.revoke',
  'ballot.cast', 'ballot.withdraw', 'ballot.approve'));
ALTER TABLE access.vote_admission ADD CONSTRAINT vote_admission_operation_proof CHECK (CASE
  WHEN operation IN ('ballot.cast', 'ballot.withdraw') THEN
    authority_path IN ('holder-mandate', 'proxy-mandate') AND grant_id IS NULL
    AND holder_subject IS NOT NULL AND seat IS NOT NULL AND source_entitlement IS NOT NULL
    AND (proxy_subject IS NOT NULL) = (authority_path = 'proxy-mandate')
  WHEN operation = 'ballot.approve' THEN
    authority_path = 'holder-mandate' AND grant_id IS NULL AND proxy_subject IS NULL
    AND holder_subject IS NOT NULL AND seat IS NOT NULL AND source_entitlement IS NOT NULL
    AND policy_id IS NOT NULL
  WHEN operation IN ('allocation.activate', 'holder-charter.set') THEN
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
END);

CREATE OR REPLACE FUNCTION access.vote_admission_action(operation text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN operation IN ('ballot.cast', 'ballot.withdraw', 'ballot.approve') THEN 'governance.ballot.operate'
    WHEN operation IN ('allocation.activate', 'holder-charter.set', 'proxy.designate', 'proxy.revoke')
      THEN 'governance.seat.manage'
    WHEN operation = 'ballot.invalidate' THEN 'governance.ballot.invalidate'
    ELSE 'governance.poll.administer'
END
$$;
