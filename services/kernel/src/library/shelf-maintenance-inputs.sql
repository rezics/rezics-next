WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id)
SELECT EXISTS(SELECT 1 FROM library.entry WHERE route=(SELECT arg.route FROM input arg) AND account_id=(SELECT arg.account_id FROM input arg) LIMIT 1) AS entries,
 EXISTS(SELECT 1 FROM library.collection WHERE route=(SELECT arg.route FROM input arg) AND curator_account_id=(SELECT arg.account_id FROM input arg) LIMIT 1) AS collections,
 EXISTS(SELECT 1 FROM library.progress_session WHERE state <> 'retired' AND route=(SELECT arg.route FROM input arg) AND account_id=(SELECT arg.account_id FROM input arg) LIMIT 1) AS sessions;
