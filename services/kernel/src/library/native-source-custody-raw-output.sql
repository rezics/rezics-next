-- Each mutually exclusive raw branch seeks an owner-indexed native tuple before its limit.
WITH input AS NOT MATERIALIZED (SELECT :account_route::integer AS route, :account_id::uuid AS account_id, :after::nullable(uuid) AS after_key, :limit::integer AS batch_limit)
SELECT raw.key,raw.tie,raw."subjectId",raw."transactionId"
FROM input i CROSS JOIN LATERAL (
(SELECT log_id::text AS key,''::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.published_log WHERE route=i.route AND account_id=i.account_id AND i.after_key IS NULL
ORDER BY log_id LIMIT i.batch_limit)
UNION ALL
(SELECT log_id::text AS key,''::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.published_log WHERE route=i.route AND account_id=i.account_id AND i.after_key IS NOT NULL
AND log_id>i.after_key
ORDER BY log_id LIMIT i.batch_limit)
) raw ORDER BY raw.key COLLATE "C",raw.tie COLLATE "C";
