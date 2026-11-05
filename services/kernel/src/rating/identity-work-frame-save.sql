INSERT INTO rating.identity_work_frame
  (route, voter_id, generation, work_id, state, mode, cursor, through_key, selected)
VALUES ($1::integer, $2::uuid, $3::bigint, $4::uuid, $5::text, $6::text, $7::jsonb, $8::jsonb, $9::jsonb)
ON CONFLICT (route, voter_id) DO UPDATE
SET generation = EXCLUDED.generation, work_id = EXCLUDED.work_id, state = EXCLUDED.state,
    mode = EXCLUDED.mode, cursor = EXCLUDED.cursor, through_key = EXCLUDED.through_key,
    selected = EXCLUDED.selected;
