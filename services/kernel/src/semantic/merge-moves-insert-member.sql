INSERT INTO semantic.merge_member (route, subject_id, member_id, phase, cursor)
VALUES (:route::integer, :subject_id::uuid, :member_id::uuid, :phase::text, :cursor::jsonb)
ON CONFLICT DO NOTHING RETURNING member_id;
