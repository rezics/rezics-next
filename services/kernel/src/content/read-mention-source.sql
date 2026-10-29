SELECT p.post_id::text, p.thread_id::text, p.author_account_id::text AS actor_id,
       p.reply_to_post_id::text, parent.author_account_id::text AS parent_author_id,
       t.first_post_id::text,
       opening.author_account_id::text AS first_post_author_id,
       p.visibility, p.availability, r.revision_id::text, r.body,
       t.visibility AS thread_visibility, t.availability AS thread_availability,
       t.board_id::text, b.visibility AS board_visibility, b.realm_id::text
FROM content.post p
JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
JOIN content.post opening ON opening.route = t.route AND opening.post_id = t.first_post_id
LEFT JOIN content.post parent ON parent.route = p.route AND parent.post_id = p.reply_to_post_id
JOIN content.revision r ON r.route = p.route AND r.thread_id = p.thread_id
  AND r.post_id = p.post_id AND r.revision_id = :revision_id::uuid
JOIN content.board b ON b.route = t.route AND b.board_id = t.board_id
WHERE p.route = :route::integer AND p.post_id = :post_id::uuid;
