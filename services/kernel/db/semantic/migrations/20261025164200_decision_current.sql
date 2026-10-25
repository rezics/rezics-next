-- migrate:up
CREATE TABLE semantic.acceptance_current (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  context_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  head integer NOT NULL CHECK (head >= 1),
  verdict text NOT NULL CHECK (verdict IN ('accept', 'reject', 'abstain')),
  revision integer NOT NULL,
  PRIMARY KEY (route, subject_id, context_id, candidate_id),
  FOREIGN KEY (route, subject_id, candidate_id)
    REFERENCES semantic.candidate (route, subject_id, candidate_id),
  FOREIGN KEY (route, subject_id, context_id, candidate_id, head)
    REFERENCES semantic.acceptance (route, subject_id, context_id, candidate_id, head),
  FOREIGN KEY (route, subject_id, revision)
    REFERENCES semantic.revision (route, subject_id, revision),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);

INSERT INTO semantic.acceptance_current
  (route, subject_id, context_id, candidate_id, slot_id, head, verdict, revision)
SELECT DISTINCT ON (a.route, a.subject_id, a.context_id, a.candidate_id)
       a.route, a.subject_id, a.context_id, a.candidate_id, c.slot_id, a.head, a.verdict, a.revision
FROM semantic.acceptance a
JOIN semantic.candidate c USING (route, subject_id, candidate_id)
ORDER BY a.route, a.subject_id, a.context_id, a.candidate_id, a.head DESC;

CREATE INDEX acceptance_current_rejected
  ON semantic.acceptance_current (route, subject_id, context_id, slot_id, revision DESC, candidate_id)
  WHERE verdict = 'reject';

-- migrate:down
DROP TABLE semantic.acceptance_current;
