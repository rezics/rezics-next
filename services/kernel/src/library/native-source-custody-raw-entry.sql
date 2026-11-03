-- State entries and independent personal-entry facts share the existing private entry source family.
WITH input AS NOT MATERIALIZED (
  SELECT :account_route::integer AS route, :account_id::uuid AS account_id,
         :after::nullable(uuid) AS after_key, :tie::text AS after_tie, :limit::integer AS batch_limit
), raw AS (
  (SELECT e.subject_id AS key,''::text AS tie,e.subject_id AS "subjectId",e.transaction_id AS "transactionId"
   FROM library.entry e CROSS JOIN input i WHERE e.route=i.route AND e.account_id=i.account_id
     AND (i.after_key IS NULL OR (e.subject_id,''::text)>(i.after_key,i.after_tie))
   ORDER BY e.subject_id,''::text LIMIT (SELECT batch_limit FROM input))
  UNION ALL
  (SELECT p.subject_id AS key,'personal'::text AS tie,p.subject_id AS "subjectId",p.transaction_id AS "transactionId"
   FROM library.entry_personal_fact p CROSS JOIN input i
   WHERE p.route=i.route AND p.account_id=i.account_id
     AND (p.note IS NOT NULL OR p.priority IS NOT NULL OR EXISTS(
       SELECT 1 FROM library.entry_source_observation o WHERE o.route=p.route AND o.account_id=p.account_id
         AND o.subject_id=p.subject_id))
     AND (i.after_key IS NULL OR (p.subject_id,'personal'::text)>(i.after_key,i.after_tie))
   ORDER BY p.subject_id,'personal'::text LIMIT (SELECT batch_limit FROM input))
)
SELECT raw.key::text,raw.tie,raw."subjectId"::text,raw."transactionId"::text
FROM raw CROSS JOIN input i
WHERE i.after_key IS NULL OR (raw.key,raw.tie)>(i.after_key,i.after_tie)
ORDER BY raw.key,raw.tie COLLATE "C" LIMIT (SELECT batch_limit FROM input);
