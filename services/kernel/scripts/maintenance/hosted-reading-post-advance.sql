-- One resumable transaction addresses at most 100 remaining development checkpoints.
-- Apply current canonical migrations after prepare and before this command.
BEGIN;
WITH page AS MATERIALIZED (
  SELECT * FROM library.hosted_reading
  WHERE target_post_id IS NULL
  ORDER BY route,account_id,subject_id LIMIT 100 FOR UPDATE
), classified AS MATERIALIZED (
  SELECT p.*,selected.post_id AS exact_post
  FROM page p LEFT JOIN LATERAL (
    SELECT occurrence.post_id FROM content.hosted_occurrence occurrence
    JOIN content.revision revision
      ON revision.route=get_byte(uuid_send(p.target_revision_id),10)*256+get_byte(uuid_send(p.target_revision_id),11)
     AND revision.thread_id=occurrence.thread_id AND revision.post_id=occurrence.post_id
     AND revision.revision_id=p.target_revision_id AND revision.body_sha256=p.target_sha256
    WHERE occurrence.route=get_byte(uuid_send(p.catalogue_id),10)*256+get_byte(uuid_send(p.catalogue_id),11)
      AND occurrence.catalogue_id=p.catalogue_id AND occurrence.occurrence_id=p.occurrence_id
      AND occurrence.kind='chapter' OFFSET 0
  ) selected ON true
), retained AS (
  INSERT INTO library.hosted_reading_unsupported(route,account_id,subject_id,evidence,reason)
  SELECT route,account_id,subject_id,to_jsonb(c)-'exact_post','exact_target_unavailable'
  FROM classified c WHERE exact_post IS NULL
  RETURNING route,account_id,subject_id
), removed AS (
  DELETE FROM library.hosted_reading h USING retained r
  WHERE (h.route,h.account_id,h.subject_id)=(r.route,r.account_id,r.subject_id)
  RETURNING h.subject_id
), converted AS (
  UPDATE library.hosted_reading h SET target_post_id=c.exact_post
  FROM classified c
  WHERE (h.route,h.account_id,h.subject_id)=(c.route,c.account_id,c.subject_id) AND c.exact_post IS NOT NULL
  RETURNING h.subject_id
)
SELECT (SELECT count(*) FROM page) AS examined,
       (SELECT count(*) FROM converted) AS converted,
       (SELECT count(*) FROM removed) AS retained_unsupported;
COMMIT;
