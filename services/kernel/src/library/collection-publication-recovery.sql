-- Selection for work only. The publication worker reopens the original native episode and activation.
SELECT e.publication_id::text AS "publicationId"
FROM library.collection c
JOIN access.account a ON a.route=c.route AND a.account_id=c.curator_account_id
 AND a.state='active' AND NOT a.authn_fenced
JOIN library.collection_source_output_head h
 ON h.route=c.route AND h.collection_id=c.collection_id AND h.source_generation=c.source_generation
JOIN library.collection_publication_staging s
 ON s.route=h.route AND s.collection_id=h.collection_id AND s.generation=h.generation
 AND s.account_id=c.curator_account_id
JOIN library.collection_publication_episode e
 ON e.route=s.route AND e.publication_id=s.publication_id AND e.collection_id=s.collection_id
 AND e.owner_account_id=s.account_id AND e.phase='complete'
WHERE c.route=$1 AND c.collection_id=$2 AND c.curator_account_id=$3
 AND c.state='active' AND c.visibility IN ('public','unlisted') AND c.builtin_kind IN ('everything','state')
 AND NOT EXISTS (
   SELECT 1 FROM semantic.identity_public_output_seal q
   WHERE q.partition_no=(h.route >> 4) AND q.capture_id=h.generation
 );
