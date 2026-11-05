DELETE FROM semantic.merge_member
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND member_id = :member_id::uuid;
