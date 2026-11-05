WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id,
         :at::timestamptz AS at, :revision::integer AS revision, :transaction_id::uuid AS transaction_id
)
INSERT INTO semantic.record_lifecycle
  (route, subject_id, candidate_id, revision, state, deletion_generation, deletion_transaction_id, deleted_at, purge_after)
SELECT route, subject_id, candidate_id, revision, 'deleted', gen_random_uuid(), transaction_id,
       at, at + interval '720 hours' FROM input
ON CONFLICT (route, subject_id, candidate_id) DO UPDATE
SET state='deleted', version=semantic.record_lifecycle.version+1
WHERE semantic.record_lifecycle.state='active'
RETURNING state, deleted_at, purge_after, held, version AS security_revision;
