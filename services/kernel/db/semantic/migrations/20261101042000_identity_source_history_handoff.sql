-- migrate:up
-- Source already rechecks genuine Account settlement before subject discharge.
-- Keep that same native terminal check usable for discharged as well as transferred rows.
CREATE OR REPLACE FUNCTION semantic.identity_source_consumer_terminal_matches(
 p_home integer,p_custody bigint,p_sequence bigint,p_reference jsonb,p_generation jsonb,p_tx uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE matched boolean;
BEGIN
 IF NOT semantic.identity_source_consumer_terminal_hook_installed() THEN RETURN false; END IF;
 EXECUTE $q$SELECT EXISTS(
  SELECT 1 FROM semantic.identity_epoch_source_consumer_terminal t
  JOIN semantic.identity_epoch_source_consumer_custody r ON r.partition_no=t.partition_no
   AND r.erasure_key=t.custody_key
  JOIN semantic.erasure_source_commit n ON n.partition_no=t.partition_no
   AND n.transaction_id=t.transaction_id AND n.epoch=t.owner_epoch AND n.xmin=t.xmin
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
   AND p.write_state='active' AND p.moved_to IS NULL
   AND (p.position>=n.position OR (n.transaction_id=$6 AND n.position=p.position+1))
  WHERE t.partition_no=$1 AND t.custody_key=$2 AND t.sequence=$3 AND t.state=CASE WHEN $4->>'erasedRole'='subject' THEN 'discharged' ELSE 'transferred' END
   AND r.receipt_key::jsonb=jsonb_build_array($4#>>'{receipt,kind}',$4#>>'{receipt,account}',$4#>>'{receipt,receipt}')
   AND r.source_digest=$4->>'sourceDigest' AND r.source_epoch::text=$4#>>'{source,epoch}'
   AND r.source_position::text=$4#>>'{source,position}' AND r.source_transaction_id::text=$4#>>'{source,transactionId}'
   AND r.job_id::text=$4#>>'{job,jobId}' AND r.job_epoch::text=$4#>>'{job,epoch}'
   AND r.barrier_account_id::text=$4#>>'{barrier,accountId}'
   AND r.barrier_account_route::text=$4#>>'{barrier,accountRoute}'
   AND r.barrier_version::text=$4#>>'{barrier,version}' AND r.barrier_at=($4#>>'{barrier,at}')::timestamptz
   AND r.erased_role=$4->>'erasedRole' AND r.binding_generation=t.replay_generation
   AND t.replay_generation::text=$5->>'replayGeneration'
   AND t.undo_generation::text=$5->>'undoGeneration' AND t.restore_generation::text=$5->>'restoreGeneration'
 )$q$ INTO matched USING p_home,p_custody,p_sequence,p_reference,p_generation,p_tx;
 RETURN matched;
END $$;

-- The authority remains the original enrolled Source custody and terminal pointer.
-- No copied terminal, handoff ledger, History mutation or foreign SDK SQL is installed.
CREATE FUNCTION semantic.lock_identity_source_history_handoff(p_reference jsonb, p_expected jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE authority jsonb;
BEGIN
 -- The receiving owner is home zero. There is no cross-home atomic bridge here.
 IF p_reference IS NULL OR octet_length(p_reference::text)>2048
  OR octet_length(p_expected::text)>4096
  OR p_reference#>>'{source,partition}' IS DISTINCT FROM '0'
  OR (p_reference#>>'{barrier,accountRoute}')::integer/16 IS DISTINCT FROM 0 THEN RETURN NULL; END IF;

 SELECT jsonb_build_object(
   'kind','identity-source-history-guard/v1',
   'custody',r.erasure_key::text,'sequence',t.sequence::text,
   -- Reconstruct the closed address from ORIGINAL native fields. Extra caller
   -- JSON must never become persisted payload in a later History consumer.
   'reference',jsonb_build_object(
     'receipt',c.receipt,'sourceDigest',r.source_digest,'erasedRole',r.erased_role,
     'source',jsonb_build_object('partition',r.partition_no,'epoch',r.source_epoch,
       'position',r.source_position::text,'transactionId',r.source_transaction_id),
     'job',jsonb_build_object('jobId',r.job_id,'epoch',r.job_epoch::text),
     'barrier',jsonb_build_object('accountId',r.barrier_account_id,
       'accountRoute',r.barrier_account_route,'version',r.barrier_version,'at',r.barrier_at::text)),
   'generation',jsonb_build_object('replayGeneration',t.replay_generation::text,
     'undoGeneration',t.undo_generation::text,'restoreGeneration',t.restore_generation::text),
   'disposition',t.state,
   'terminal',jsonb_build_object('partition',t.partition_no,'epoch',t.owner_epoch,
     'position',terminal_commit.position::text,'transactionId',t.transaction_id),
   'receiving',CASE WHEN t.state='transferred' THEN jsonb_build_object(
     'partition',t.receiving_partition,'epoch',t.receiving_epoch,
     'position',t.receiving_position::text,'transactionId',t.receiving_transaction_id) ELSE NULL END
 ) INTO authority
 FROM semantic.identity_epoch_receipt_binding b
 JOIN semantic.identity_epoch_source_consumer_custody r ON r.partition_no=b.partition_no
  AND r.erasure_key=b.consumer_terminal_custody AND r.receipt_key=b.receipt_key
  AND r.binding_generation=b.generation AND r.source_digest=b.intent_digest
  AND r.job_id=b.accepted_job AND r.job_epoch=b.accepted_epoch
 JOIN semantic.identity_epoch_source_consumer_terminal t ON t.partition_no=r.partition_no
  AND t.custody_key=r.erasure_key AND t.sequence=b.consumer_terminal_sequence
  AND t.replay_generation=b.generation AND t.undo_generation=b.consumer_undo_generation
 JOIN semantic.identity_epoch_receipt_claim c ON c.partition_no=b.partition_no
  AND c.receipt_key=b.receipt_key AND c.generation=b.generation
  AND c.intent_digest=b.intent_digest AND c.scope_digest=r.scope_digest
  AND c.job_id=r.job_id AND c.job_epoch=r.job_epoch AND NOT c.imported
 JOIN semantic.identity_epoch_receipt_claim_commit k ON k.partition_no=c.partition_no
  AND k.receipt_key=c.receipt_key AND k.generation=c.generation
  AND k.transaction_id=r.binding_transaction_id AND k.transaction_id=c.transaction_id AND k.xmin=c.xmin
 JOIN semantic.identity_epoch_native_commit admission ON admission.partition_no=k.partition_no
  AND admission.transaction_id=k.transaction_id AND admission.purpose='admission' AND admission.xmin=k.xmin
 JOIN semantic.identity_epoch_native_commit undo ON undo.partition_no=b.partition_no
  AND undo.transaction_id=b.consumer_undo_transaction_id AND undo.purpose='admission'
 JOIN semantic.erasure_source_commit retained ON retained.partition_no=r.partition_no
  AND retained.transaction_id=r.transaction_id AND retained.epoch=r.owner_epoch AND retained.xmin=r.xmin
 JOIN semantic.erasure_source_commit terminal_commit ON terminal_commit.partition_no=t.partition_no
  AND terminal_commit.transaction_id=t.transaction_id AND terminal_commit.epoch=t.owner_epoch
  AND terminal_commit.xmin=t.xmin
 JOIN core.partition p ON p.partition_no=b.partition_no AND p.write_state='active' AND p.moved_to IS NULL
  AND p.epoch=r.source_epoch AND p.epoch=r.owner_epoch AND p.epoch=t.owner_epoch
  AND p.epoch=admission.epoch AND p.epoch=undo.epoch AND p.epoch=t.restore_generation
  AND p.position>=r.source_position AND p.position>=admission.position AND p.position>=undo.position
  AND p.position>=retained.position AND p.position>=terminal_commit.position
 JOIN semantic.erasure_source_role retained_role ON retained_role.partition_no=r.partition_no
  AND retained_role.transaction_id=r.transaction_id AND retained_role.account_id=r.barrier_account_id
  AND retained_role.role=CASE r.erased_role WHEN 'subject' THEN 'subject' WHEN 'requester' THEN 'actor' ELSE 'editor' END
 JOIN semantic.erasure_source_role terminal_role ON terminal_role.partition_no=t.partition_no
  AND terminal_role.transaction_id=t.transaction_id AND terminal_role.account_id=r.barrier_account_id
  AND terminal_role.role=retained_role.role
 JOIN semantic.erasure_locator retained_locator ON retained_locator.partition_no=r.partition_no
  AND retained_locator.account_id=r.barrier_account_id AND retained_locator.role=retained_role.role
  AND retained_locator.store='identity_epoch_source_consumer_custody' AND retained_locator.record_key=r.erasure_key
  AND retained_locator.source_transaction_id=r.transaction_id
 JOIN semantic.erasure_locator terminal_locator ON terminal_locator.partition_no=t.partition_no
  AND terminal_locator.account_id=r.barrier_account_id AND terminal_locator.role=terminal_role.role
  AND terminal_locator.store='identity_epoch_source_consumer_terminal' AND terminal_locator.record_key=t.erasure_key
  AND terminal_locator.source_transaction_id=t.transaction_id
 JOIN pg_catalog.pg_trigger hook ON hook.tgrelid='semantic.identity_epoch_source_consumer_terminal'::regclass
  AND hook.tgname='identity_source_consumer_binding_fence' AND NOT hook.tgisinternal AND hook.tgenabled='O'
  AND hook.tgfoid='semantic.bind_identity_source_consumer_terminal()'::regprocedure
 WHERE b.partition_no=0 AND b.state='accepted'
  AND b.receipt_key=format('[%s,%s,%s]',to_json(p_reference#>>'{receipt,kind}'),
    to_json(p_reference#>>'{receipt,account}'),to_json(p_reference#>>'{receipt,receipt}'))
  AND c.receipt=p_reference->'receipt' AND b.account_id::text=p_reference#>>'{receipt,account}'
  AND r.source_digest=p_reference->>'sourceDigest'
  AND r.source_epoch::text=p_reference#>>'{source,epoch}'
  AND r.source_position::text=p_reference#>>'{source,position}'
  AND r.source_transaction_id::text=p_reference#>>'{source,transactionId}'
  AND r.job_id::text=p_reference#>>'{job,jobId}' AND r.job_epoch::text=p_reference#>>'{job,epoch}'
  AND r.barrier_account_id::text=p_reference#>>'{barrier,accountId}'
  AND r.barrier_account_route::text=p_reference#>>'{barrier,accountRoute}'
  AND r.barrier_version::text=p_reference#>>'{barrier,version}'
  AND r.barrier_at=(p_reference#>>'{barrier,at}')::timestamptz
  AND r.erased_role=p_reference->>'erasedRole'
  AND ((r.erased_role='subject' AND t.state='discharged' AND r.barrier_account_id=b.account_id)
    OR (r.erased_role IN ('requester','decider') AND t.state='transferred'
      AND t.receiving_partition=0 AND t.receiving_epoch=p.epoch
      AND t.receiving_position>0 AND t.receiving_transaction_id IS NOT NULL))
 FOR UPDATE OF b FOR SHARE OF r,t,c,k,admission,undo,retained,terminal_commit,p,
   retained_role,terminal_role,retained_locator,terminal_locator;

 IF p_expected IS NOT NULL AND authority IS DISTINCT FROM p_expected THEN RETURN NULL; END IF;
 RETURN authority;
END $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.identity_source_consumer_terminal_matches(
 p_home integer,p_custody bigint,p_sequence bigint,p_reference jsonb,p_generation jsonb,p_tx uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE matched boolean;
BEGIN
 IF NOT semantic.identity_source_consumer_terminal_hook_installed() THEN RETURN false; END IF;
 EXECUTE $q$SELECT EXISTS(
  SELECT 1 FROM semantic.identity_epoch_source_consumer_terminal t
  JOIN semantic.identity_epoch_source_consumer_custody r ON r.partition_no=t.partition_no
   AND r.erasure_key=t.custody_key
  JOIN semantic.erasure_source_commit n ON n.partition_no=t.partition_no
   AND n.transaction_id=t.transaction_id AND n.epoch=t.owner_epoch AND n.xmin=t.xmin
  JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
   AND p.write_state='active' AND p.moved_to IS NULL
   AND (p.position>=n.position OR (n.transaction_id=$6 AND n.position=p.position+1))
  WHERE t.partition_no=$1 AND t.custody_key=$2 AND t.sequence=$3 AND t.state='transferred'
   AND r.receipt_key::jsonb=jsonb_build_array($4#>>'{receipt,kind}',$4#>>'{receipt,account}',$4#>>'{receipt,receipt}')
   AND r.source_digest=$4->>'sourceDigest' AND r.source_epoch::text=$4#>>'{source,epoch}'
   AND r.source_position::text=$4#>>'{source,position}' AND r.source_transaction_id::text=$4#>>'{source,transactionId}'
   AND r.job_id::text=$4#>>'{job,jobId}' AND r.job_epoch::text=$4#>>'{job,epoch}'
   AND r.barrier_account_id::text=$4#>>'{barrier,accountId}'
   AND r.barrier_account_route::text=$4#>>'{barrier,accountRoute}'
   AND r.barrier_version::text=$4#>>'{barrier,version}' AND r.barrier_at=($4#>>'{barrier,at}')::timestamptz
   AND r.erased_role=$4->>'erasedRole' AND r.binding_generation=t.replay_generation
   AND t.replay_generation::text=$5->>'replayGeneration'
   AND t.undo_generation::text=$5->>'undoGeneration' AND t.restore_generation::text=$5->>'restoreGeneration'
 )$q$ INTO matched USING p_home,p_custody,p_sequence,p_reference,p_generation,p_tx;
 RETURN matched;
END $$;

DROP FUNCTION semantic.lock_identity_source_history_handoff(jsonb,jsonb);
