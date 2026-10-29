SELECT thread_id
FROM content.thread
WHERE route = :route::integer AND board_id = :board_id::uuid
  AND author_account_id = :author_id::uuid AND review_subject_id = :subject_id::uuid
  AND kind = 'review' AND review_live AND availability = 'available' AND visibility <> 'taken_down';
