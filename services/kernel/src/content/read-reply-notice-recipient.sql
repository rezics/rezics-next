-- All joins stay on one thread route; each side is an exact primary-key probe.
SELECT recipient.author_account_id
FROM content.post post
JOIN content.thread thread ON thread.route = post.route AND thread.thread_id = post.thread_id
JOIN content.post recipient ON recipient.route = post.route AND recipient.thread_id = post.thread_id
  AND recipient.post_id = coalesce(post.reply_to_post_id, thread.first_post_id)
WHERE post.route = :route::integer AND post.thread_id = :thread_id::uuid AND post.post_id = :post_id::uuid
  AND post.visibility = 'published' AND thread.visibility <> 'draft';
