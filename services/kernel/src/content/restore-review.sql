UPDATE content.thread t SET review_live = true
WHERE t.route = :route::integer AND t.thread_id = :thread_id::uuid
  AND t.first_post_id = :post_id::uuid AND t.kind = 'review' AND NOT t.review_live
  AND t.availability = 'available' AND t.visibility <> 'taken_down'
  AND EXISTS (SELECT 1 FROM content.post p WHERE p.route = t.route
    AND p.post_id = t.first_post_id AND p.visibility <> 'taken_down');
