SELECT g.pending_job,g.pending_epoch,g.published_epoch,
        EXISTS(SELECT 1 FROM semantic.redirect r WHERE r.route=$2 AND r.subject_id=$3) redirected
        FROM semantic.identity_epoch_group g WHERE g.partition_no=$1 AND g.terminal=$3;
