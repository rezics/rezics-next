SELECT s.recorded_transaction_id FROM semantic.subject s
      JOIN semantic.revision r ON (r.route,r.subject_id,r.revision)=(s.route,s.subject_id,1)
      WHERE s.route=$1 AND s.subject_id=$2 AND r.kind='create'
      AND s.recorded_transaction_id=r.recorded_transaction_id
      AND s.xmin::text=pg_current_xact_id()::text AND r.xmin::text=pg_current_xact_id()::text
      AND NOT EXISTS(SELECT 1 FROM semantic.revision later WHERE later.route=s.route AND later.subject_id=s.subject_id AND later.revision>1)
      AND NOT EXISTS(SELECT 1 FROM semantic.redirect d WHERE d.route=s.route AND d.subject_id=s.subject_id);
