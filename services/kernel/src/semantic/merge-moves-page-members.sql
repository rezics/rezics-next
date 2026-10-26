SELECT member_id::text, phase, cursor FROM semantic.merge_member
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND member_id > :after_member::uuid
ORDER BY member_id LIMIT 100;
