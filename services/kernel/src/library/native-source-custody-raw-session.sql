-- Each mutually exclusive raw branch seeks an owner-indexed native tuple before its limit.
WITH input AS NOT MATERIALIZED (SELECT :account_route::integer AS route, :account_id::uuid AS account_id, :after::nullable(uuid) AS after_key)
SELECT raw.key,raw.tie,raw."subjectId",raw."transactionId"
FROM input i CROSS JOIN LATERAL (
(SELECT session_id::text AS key,''::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.progress_session WHERE state <> 'retired' AND route=i.route AND account_id=i.account_id AND i.after_key IS NULL
ORDER BY session_id LIMIT 1)
UNION ALL
(SELECT session_id::text AS key,''::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.progress_session WHERE state <> 'retired' AND route=i.route AND account_id=i.account_id AND i.after_key IS NOT NULL
AND session_id>i.after_key
ORDER BY session_id LIMIT 1)
) raw ORDER BY raw.key COLLATE "C",raw.tie COLLATE "C";
