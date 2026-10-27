WITH input AS (SELECT :time::timestamptz AS time)
UPDATE library.entry
SET activity_at = GREATEST(activity_at, input.time),
    finished_at = CASE WHEN :completed::boolean THEN GREATEST(finished_at, input.time) ELSE finished_at END
FROM input
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id;
