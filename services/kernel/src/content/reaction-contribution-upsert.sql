-- Each actor slot converges independently, even when its source partition's effects arrive out of order.
INSERT INTO content.reaction_contribution AS stored
  (route, target_id, actor_account_id, kind, source_epoch, source_position)
VALUES (:route::integer, :target_id::uuid, :actor_id::uuid, :kind::nullable(text),
        :source_epoch::integer, :source_position::bigint)
ON CONFLICT (route, target_id, actor_account_id) DO UPDATE
SET kind = EXCLUDED.kind, source_epoch = EXCLUDED.source_epoch, source_position = EXCLUDED.source_position
WHERE (stored.source_epoch, stored.source_position) < (EXCLUDED.source_epoch, EXCLUDED.source_position)
RETURNING WITH (OLD AS previous) previous.kind AS previous_kind;
