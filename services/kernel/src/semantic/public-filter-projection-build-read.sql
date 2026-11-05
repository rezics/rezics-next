SELECT build_id::text, generation::text, route, owner_epoch, source_position::text, privacy_position::text,
       terminal_id::text, subject_revision, security_revision::text, current_release
FROM semantic.public_filter_projection_build
WHERE partition_no = :partition_no::integer AND subject_id = :subject_id::uuid
  AND route = :route::integer
  AND meaning_digest = :meaning_digest AND meaning_type = :meaning_type;
