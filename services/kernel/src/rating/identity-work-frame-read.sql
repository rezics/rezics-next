SELECT generation::text, work_id AS "workId", state, mode, cursor, through_key AS "through", selected
FROM rating.identity_work_frame
WHERE route = $1::integer AND voter_id = $2::uuid
FOR UPDATE;
