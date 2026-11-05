SELECT COALESCE(array_agg(page.actor_account_id::text ORDER BY page.actor_account_id), ARRAY[]::text[]) AS actors
FROM (
  SELECT actor_account_id
  FROM content.subject_reactor
  WHERE route = :route::integer
    AND subject_id = :subject_id::uuid
    AND actor_account_id > :cursor::uuid
  ORDER BY actor_account_id
  LIMIT 100
) AS page;
