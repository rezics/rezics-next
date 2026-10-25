-- migrate:up
CREATE TABLE semantic.redirect (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  sequence integer NOT NULL,
  target uuid NOT NULL CHECK (target < subject_id),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, sequence),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id)
);
CREATE TRIGGER redirect_immutable BEFORE UPDATE OR DELETE ON semantic.redirect
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE TABLE semantic.merge_member (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  member_id uuid NOT NULL CHECK (subject_id < member_id),
  phase text NOT NULL DEFAULT 'links' CHECK (phase IN ('links', 'members', 'done')),
  cursor jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (route, subject_id, member_id),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id)
);
CREATE INDEX merge_member_pending ON semantic.merge_member (route, subject_id, member_id) WHERE phase <> 'done';

-- migrate:down
DROP TABLE semantic.merge_member;
DROP TABLE semantic.redirect;
