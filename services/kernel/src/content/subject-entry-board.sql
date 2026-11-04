-- Read the exact native Board-to-Subject association for explicit Subject entry.
SELECT b.board_id, b.subject_id, b.realm_id, b.purpose
FROM content.board b
WHERE b.route = :route::integer AND b.board_id = :board_id::uuid;
