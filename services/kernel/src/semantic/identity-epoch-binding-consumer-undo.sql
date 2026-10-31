WITH parameters AS (SELECT $6::uuid AS transaction_id)
UPDATE semantic.identity_epoch_receipt_binding b
SET consumer_undo_generation=b.consumer_undo_generation+1,
 consumer_undo_transaction_id=CASE WHEN b.consumer_undo_generation IS NULL THEN NULL
 ELSE (SELECT transaction_id FROM parameters) END
WHERE b.partition_no=$1 AND b.receipt_key=$2 AND b.state='accepted'
 AND b.accepted_job=$3 AND b.accepted_epoch=$4
 AND b.consumer_terminal_custody IS NULL
 AND EXISTS(SELECT 1 FROM semantic.identity_epoch_receipt_claim c
   WHERE c.partition_no=b.partition_no AND c.receipt_key=$5
    AND c.transaction_id=(SELECT transaction_id FROM parameters) AND NOT c.imported
    AND c.receipt->>'kind'='account-agent.unverify' AND c.intent->>'kind'='unmerge'
    AND c.xmin=pg_current_xact_id()::xid);
