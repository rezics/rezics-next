WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(original uuid,terminal uuid,present boolean)),
          removed AS (DELETE FROM semantic.identity_epoch_legacy_member m USING input i WHERE m.partition_no=$2
            AND (m.terminal,m.original)=(i.terminal,i.original) AND NOT i.present)
          INSERT INTO semantic.identity_epoch_legacy_member(partition_no,terminal,original,source_partition,source_generation)
          SELECT $2,terminal,original,$3,$4 FROM input WHERE present ON CONFLICT(terminal,original) DO UPDATE SET source_generation=excluded.source_generation;
