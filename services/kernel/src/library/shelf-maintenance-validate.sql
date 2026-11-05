WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id)
SELECT subject_id AS id,(incarnation_id IS NOT NULL AND activity_at IS NOT NULL AND type_id IS NOT NULL
 AND type_source_id IS NOT NULL AND EXISTS(SELECT 1 FROM library.shelf_type_value v WHERE v.route=(SELECT arg.route FROM input arg)
 AND v.account_id=(SELECT arg.account_id FROM input arg) AND v.type_id=entry.type_id)) AS valid
 FROM library.entry WHERE route=(SELECT arg.route FROM input arg) AND account_id=(SELECT arg.account_id FROM input arg) AND subject_id>:after::uuid ORDER BY subject_id LIMIT 1;
