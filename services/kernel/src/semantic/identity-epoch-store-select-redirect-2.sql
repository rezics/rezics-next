SELECT 1 FROM semantic.redirect
        WHERE route=$1 AND subject_id=$2 LIMIT 1;
