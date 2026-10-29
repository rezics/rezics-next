-- migrate:up
CREATE INDEX reaction_liked_subject
  ON content.reaction (route, actor_account_id, target_id)
  WHERE target_kind = 'subject' AND kind IN ('like', 'love');

-- migrate:down
DROP INDEX content.reaction_liked_subject;
