-- migrate:up

-- Subject slots use the actor-owned reaction table. Their score kinds remain
-- exclusive to thread and post reactions.
ALTER TABLE content.reaction
  DROP CONSTRAINT reaction_target_kind_check,
  ADD CONSTRAINT reaction_target_kind_check CHECK (target_kind IN ('thread', 'post', 'subject')),
  ADD CONSTRAINT reaction_subject_kind_check CHECK (
    target_kind <> 'subject' OR kind IN ('like', 'love', 'laugh', 'insightful', 'sad')
  );

-- Merge pages seek exactly the reactors of one subject in its home partition.
CREATE TABLE content.subject_reactor (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  actor_account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('like', 'love', 'laugh', 'insightful', 'sad')),
  PRIMARY KEY (route, subject_id, actor_account_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);

-- migrate:down
DROP TABLE content.subject_reactor;
ALTER TABLE content.reaction
  DROP CONSTRAINT reaction_subject_kind_check,
  DROP CONSTRAINT reaction_target_kind_check,
  ADD CONSTRAINT reaction_target_kind_check CHECK (target_kind IN ('thread', 'post'));
