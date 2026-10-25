WITH removed AS (
  DELETE FROM library.progress_unit
  WHERE route = :route AND session_id = :session_id AND unit_id = ANY(:unit_ids::text[])
  RETURNING 1
)
SELECT count(*)::integer AS removed FROM removed;
