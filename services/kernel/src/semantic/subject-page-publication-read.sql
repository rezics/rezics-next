SELECT generation::text, readiness, public_effective_at::text, evidence, completed_position::text, witnesses,
change_position::text FROM semantic.subject_page_publication WHERE route=:route::integer AND subject_id=:subject_id::uuid;
