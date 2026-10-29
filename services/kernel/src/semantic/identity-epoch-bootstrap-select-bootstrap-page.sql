SELECT p.*,c.epoch,c.position
      FROM semantic.identity_epoch_bootstrap_page p
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(p.partition_no,p.transaction_id)
      WHERE p.partition_no=$1 AND NOT p.acknowledged AND c.purpose='bootstrap' AND p.xmin=c.xmin
      ORDER BY p.generation LIMIT 1;
