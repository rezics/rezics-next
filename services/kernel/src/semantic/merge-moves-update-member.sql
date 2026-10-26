UPDATE semantic.merge_member SET phase = :phase::text, cursor = :cursor::jsonb
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND member_id = :member_id::uuid;
