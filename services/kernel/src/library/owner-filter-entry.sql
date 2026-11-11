-- An unsequenced live fact remains unknown even beside a sequenced clear.
SELECT subject_id AS "subjectId", state, owner_write_seq::text AS "ownerWriteSeq",
       library_profile_pin AS "libraryProfilePin"
FROM (
  SELECT subject_id, state, owner_write_seq, library_profile_pin
  FROM library.entry
  WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  UNION ALL
  SELECT subject_id, NULL::text, owner_write_seq, NULL::jsonb
  FROM library.entry_clear
  WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
) facts
ORDER BY owner_write_seq DESC NULLS FIRST
LIMIT 1;
