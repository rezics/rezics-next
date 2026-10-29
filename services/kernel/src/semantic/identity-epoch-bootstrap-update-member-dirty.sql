UPDATE semantic.identity_epoch_member_dirty d SET captured_revision=r.source_revision
        FROM jsonb_to_recordset($1::jsonb) AS r(route integer,original uuid,terminal uuid,source_revision bigint)
        WHERE (d.route,d.terminal,d.original)=(r.route,r.terminal,r.original) AND d.revision=r.source_revision;
