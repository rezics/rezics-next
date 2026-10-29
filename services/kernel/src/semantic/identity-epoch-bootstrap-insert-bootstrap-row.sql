INSERT INTO semantic.identity_epoch_bootstrap_row(partition_no,transaction_id,route,original,terminal,source_revision,present)
          SELECT $1,$2,r.route,r.original,r.terminal,r.source_revision,r.present FROM jsonb_to_recordset($3::jsonb)
          AS r(route integer,original uuid,terminal uuid,source_revision bigint,present boolean);
