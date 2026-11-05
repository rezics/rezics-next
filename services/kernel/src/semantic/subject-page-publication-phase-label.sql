SELECT kind,language,property,statement_id::text,operation,body FROM semantic.current_term_fact
WHERE route=:route::integer AND subject_id=:subject_id::uuid AND kind='label' AND operation='assert'
AND language=:language::text ORDER BY log_seq DESC LIMIT 1;
