SELECT generation::text AS generation,
       work_id AS "workId",
       state,
       mode,
       cursor,
       through_key AS through,
       CASE
         WHEN selected IS NULL THEN NULL
         ELSE selected->>'pageId'
       END AS "selectedPageId"
FROM rating.identity_work_frame
WHERE route = $1::integer AND voter_id = $2::uuid;
