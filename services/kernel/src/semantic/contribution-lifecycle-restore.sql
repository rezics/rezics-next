WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id,
         :at::timestamptz AS at
)
UPDATE semantic.record_lifecycle l
SET state='active', version=l.version+1
FROM input i
WHERE l.route=i.route AND l.subject_id=i.subject_id AND l.candidate_id=i.candidate_id
  AND l.state='deleted' AND i.at < l.purge_after
RETURNING l.state, l.deleted_at, l.purge_after, l.held, l.version AS security_revision;
