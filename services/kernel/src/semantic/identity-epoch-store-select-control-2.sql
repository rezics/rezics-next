SELECT c.*,EXISTS(SELECT 1 FROM semantic.identity_epoch_job j
  WHERE j.partition_no=c.partition_no AND j.state='cancelling') retained_preparation
FROM semantic.identity_epoch_control c WHERE c.partition_no=$1 FOR UPDATE OF c;
