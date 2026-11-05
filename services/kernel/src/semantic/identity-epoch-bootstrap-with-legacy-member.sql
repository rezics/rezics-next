WITH parameters AS (SELECT $1::jsonb p1,$2::integer p2,$3::integer p3,$4::bigint p4),
input AS (SELECT * FROM jsonb_to_recordset((SELECT p1 FROM parameters)::jsonb) AS r(original uuid,terminal uuid,present boolean)),
          removed AS (DELETE FROM semantic.identity_epoch_legacy_member m USING input i WHERE m.partition_no=(SELECT p2 FROM parameters)
            AND (m.terminal,m.original)=(i.terminal,i.original) AND NOT i.present)
          INSERT INTO semantic.identity_epoch_legacy_member(partition_no,terminal,original,source_partition,source_generation)
          SELECT (SELECT p2 FROM parameters),terminal,original,(SELECT p3 FROM parameters),(SELECT p4 FROM parameters) FROM input WHERE present ON CONFLICT(partition_no,terminal,original) DO UPDATE SET source_generation=excluded.source_generation;
