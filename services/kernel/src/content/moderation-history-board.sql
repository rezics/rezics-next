SELECT NULL::uuid AS author_account_id, board_id
FROM content.board WHERE route = :route::integer AND board_id = :id::uuid;
