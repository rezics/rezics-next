SELECT subject_id AS "subjectId", state, owner_write_seq::text AS "ownerWriteSeq",
       library_profile_pin AS "libraryProfilePin"
FROM library.entry
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id;
