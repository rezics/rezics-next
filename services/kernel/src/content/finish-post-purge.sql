UPDATE content.post SET purge_completed = true
WHERE route = :route::integer AND post_id = :post_id::uuid
  AND availability = 'erased' AND purge_started_at IS NOT NULL AND NOT purge_completed;
