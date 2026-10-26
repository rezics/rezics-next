SELECT member_id FROM semantic.merge_member
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND phase <> 'done' LIMIT 1;
