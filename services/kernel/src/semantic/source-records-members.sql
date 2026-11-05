-- Current original identities, not a candidate, revision or relation-history discovery query.
SELECT member_id::text AS member_id FROM semantic.merge_member
WHERE route = :route::integer AND subject_id = :subject_id::uuid
ORDER BY member_id;
