UPDATE semantic.identity_epoch_bootstrap_home SET sealed_generation=$2,needs_work=false WHERE partition_no=$1
        AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_dirty WHERE route BETWEEN $3 AND $4 AND revision>captured_revision)
        AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_member_dirty WHERE route BETWEEN $3 AND $4 AND revision>captured_revision) RETURNING sealed_generation;
