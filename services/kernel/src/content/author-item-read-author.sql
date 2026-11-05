SELECT author_account_id
FROM content.post
WHERE route = :route::integer AND post_id = :post_id::uuid;
