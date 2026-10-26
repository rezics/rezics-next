SELECT member_id FROM semantic.merge_member
WHERE route = :route::integer AND subject_id = :subject_id::uuid ORDER BY member_id LIMIT 1;
