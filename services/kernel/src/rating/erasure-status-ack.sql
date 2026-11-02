DELETE FROM rating.erasure_page
WHERE route = :route::integer AND voter_id = :voter_id::uuid AND page_id = :page_id::uuid
  AND NOT terminal
RETURNING page_id;
