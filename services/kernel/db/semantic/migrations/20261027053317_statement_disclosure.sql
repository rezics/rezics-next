-- migrate:up
CREATE TABLE semantic.statement_disclosure (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  target_id uuid NOT NULL,
  account_id uuid NOT NULL,
  property text NOT NULL,
  disclosed boolean NOT NULL DEFAULT false,
  source_order_key text COLLATE "C" NOT NULL,
  target_order_key text COLLATE "C" NOT NULL,
  PRIMARY KEY (route, candidate_id),
  FOREIGN KEY (route, subject_id, candidate_id)
    REFERENCES semantic.candidate (route, subject_id, candidate_id)
);
CREATE INDEX statement_disclosure_outbound ON semantic.statement_disclosure
  (subject_id, account_id, property, target_order_key, target_id, candidate_id) WHERE NOT disclosed;
CREATE INDEX statement_disclosure_inbound ON semantic.statement_disclosure
  (target_id, account_id, property, source_order_key, subject_id, candidate_id) WHERE NOT disclosed;

-- migrate:down
DROP TABLE semantic.statement_disclosure;
