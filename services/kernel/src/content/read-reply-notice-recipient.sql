-- All joins stay on one thread route; each side is an exact primary-key probe.
SELECT recipient.author_account_id
FROM content.post post
JOIN content.thread thread ON thread.route = post.route AND thread.thread_id = post.thread_id
JOIN content.post recipient ON recipient.route = post.route AND recipient.thread_id = post.thread_id
  AND recipient.post_id = coalesce(post.reply_to_post_id, thread.first_post_id)
JOIN content.revision revision ON revision.route = post.route AND revision.thread_id = post.thread_id
  AND revision.post_id = post.post_id AND revision.revision_id = :revision_id::uuid
  AND revision.availability = 'available'
WHERE post.route = :route::integer AND post.thread_id = :thread_id::uuid AND post.post_id = :post_id::uuid
  AND post.author_account_id = :actor_id::uuid AND post.post_id <> thread.first_post_id;
