-- State entries and independent personal-entry facts share the existing private entry source family.
WITH input AS NOT MATERIALIZED (
  SELECT :account_route::integer AS route, :account_id::uuid AS account_id,
         :after::nullable(uuid) AS after_key, :tie::text AS after_tie, :limit::integer AS batch_limit
), raw AS (
  (SELECT e.subject_id AS key,''::text AS tie,e.subject_id AS "subjectId",e.transaction_id AS "transactionId"
   FROM library.entry e CROSS JOIN input i WHERE e.route=i.route AND e.account_id=i.account_id
     AND e.subject_id>=COALESCE(i.after_key,'00000000-0000-0000-0000-000000000000'::uuid)
     AND (i.after_key IS NULL OR (e.subject_id,''::text)>(i.after_key,i.after_tie))
   ORDER BY e.subject_id,''::text LIMIT (SELECT batch_limit FROM input))
  UNION ALL
  (SELECT c.subject_id AS key,'clear'::text AS tie,c.subject_id AS "subjectId",c.transaction_id AS "transactionId"
   FROM library.entry_clear c CROSS JOIN input i
   WHERE c.route=i.route AND c.account_id=i.account_id
     AND c.subject_id>=COALESCE(i.after_key,'00000000-0000-0000-0000-000000000000'::uuid)
     AND (i.after_key IS NULL OR (c.subject_id,'clear'::text)>(i.after_key,i.after_tie))
   ORDER BY c.subject_id,'clear'::text LIMIT (SELECT batch_limit FROM input))
  UNION ALL
  (SELECT p.subject_id AS key,'personal'::text AS tie,p.subject_id AS "subjectId",p.transaction_id AS "transactionId"
   FROM input i CROSS JOIN LATERAL library.personal_source_page(
     i.route,i.account_id,COALESCE(i.after_key,'00000000-0000-0000-0000-000000000000'::uuid),i.batch_limit+1) p
   WHERE (i.after_key IS NULL OR (p.subject_id,'personal'::text)>(i.after_key,i.after_tie))
   ORDER BY p.subject_id,'personal'::text LIMIT (SELECT batch_limit FROM input))
)
SELECT raw.key::text,raw.tie,raw."subjectId"::text,raw."transactionId"::text
FROM raw CROSS JOIN input i
WHERE i.after_key IS NULL OR (raw.key,raw.tie)>(i.after_key,i.after_tie)
ORDER BY raw.key,raw.tie COLLATE "C" LIMIT (SELECT batch_limit FROM input);
