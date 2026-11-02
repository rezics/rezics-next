-- migrate:up
-- The native page and every source key remain the original discovery records.
-- This predicate is used both before the page's first write and inside DELETE.
-- The closure owner holds real Source/control/restore locks through our COMMIT.
CREATE FUNCTION access.auth_consumer_retirement_ready(
 consumer_store text, source_row jsonb, erased_account uuid, source_role text, native_progress uuid
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE home integer; root_version integer; barrier_at timestamptz; raw_key jsonb;
BEGIN
 IF consumer_store='workflow_approval' THEN
  IF source_role NOT IN ('actor_id','erasure_subject_id','erasure_operator_id','erasure_member_id',
    'erasure_previous_operator_id','erasure_previous_subject_id','erasure_principal_id') THEN RETURN false; END IF;
  -- Only the closed own-human credential descriptor has entirely Auth-owned
  -- consumers. Registration, deletion, membership and other business effects
  -- retain their original independent source obligations.
  IF source_row->'operation'->>'kind' IS DISTINCT FROM 'credential'
   OR source_row->'operation'->>'subjectAccountId' IS DISTINCT FROM erased_account::text
   OR source_row->>'actor_id' IS DISTINCT FROM erased_account::text
   OR NOT COALESCE(source_row->'operation'->>'purpose' IN
     ('set-password','remove-password','add-key','remove-key','add-passkey','remove-passkey'),false)
   OR source_row->>'consumed_at' IS NULL THEN RETURN false; END IF;
  raw_key := jsonb_build_array(source_row->>'route',source_row->>'approval_id');
 ELSIF consumer_store='operator_opening_receipt' THEN
  IF source_role NOT IN ('operator_account_id','subject_account_id','acting_human_id','erasure_principal_id')
   THEN RETURN false; END IF;
  -- All session/consent and narrowed credential consumers belong to the subject.
  -- Erasing only its human, operator or delegate cannot discharge a live subject.
  IF source_row->>'subject_account_id' IS DISTINCT FROM erased_account::text OR source_row->>'consumed_at' IS NULL
   OR NOT COALESCE(source_row->>'purpose'='session' OR (source_row->>'purpose'='credential-management'
     AND source_row->>'credential_purpose' IN ('set-password','remove-password','add-key','remove-key')
     AND source_row->>'credential_operation_key' IS NOT NULL
     AND source_row->>'credential_effect_reference' IS NOT NULL
     AND source_row->>'credential_effect_digest' IS NOT NULL),false) THEN RETURN false; END IF;
  raw_key := jsonb_build_array(source_row->>'route',source_row->>'operator_account_id',source_row->>'receipt_id');
 ELSIF consumer_store='credential_floor_receipt' THEN
  IF source_role<>'account_id' OR source_row->>'account_id' IS DISTINCT FROM erased_account::text THEN RETURN false; END IF;
  raw_key := jsonb_build_array(source_row->>'route',source_row->>'account_id',source_row->>'opening_receipt_id');
 ELSE RETURN false;
 END IF;
 IF source_row->>source_role IS DISTINCT FROM erased_account::text THEN RETURN false; END IF;
 SELECT p.route,e.version,e.at INTO home,root_version,barrier_at
 FROM access.erasure_native_progress p JOIN access.erasure e USING(route,account_id)
 JOIN access.erasure_progress d USING(route,account_id)
 WHERE p.progress_id=native_progress AND p.account_id=erased_account AND d.store=consumer_store AND d.role=source_role
 AND d.result->'keys' @> jsonb_build_array(raw_key)
 AND (source_row->>'route')::integer/16=p.route/16
 FOR SHARE OF p,e,d;
 IF NOT FOUND THEN RETURN false; END IF;
 IF access.lock_current_auth_receiving_closure(home,erased_account,root_version,barrier_at) IS NULL THEN RETURN false; END IF;
 -- Early transfer alone is insufficient, even if a caller prepared a locator.
 PERFORM 1 FROM access.auth_history_proof h
 WHERE h.route=home AND h.account_id=erased_account AND h.phase='copies-erased'
 AND h.version=root_version AND h.at=barrier_at FOR SHARE;
 RETURN FOUND;
END $$;

-- migrate:down
-- Forward-only consumer authority; no backfill or legacy proof promotion.
