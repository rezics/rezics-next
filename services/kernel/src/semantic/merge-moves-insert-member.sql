INSERT INTO semantic.merge_member (route, subject_id, member_id, phase, cursor, publication_origin)
VALUES (:route::integer, :subject_id::uuid, :member_id::uuid, :phase::text, :cursor::jsonb, :publication_origin::jsonb)
ON CONFLICT DO NOTHING RETURNING member_id;
