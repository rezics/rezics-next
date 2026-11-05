SELECT 1 FROM semantic.identity_epoch_dirty
        WHERE route BETWEEN $1 AND $2 AND revision>captured_revision LIMIT 1;
