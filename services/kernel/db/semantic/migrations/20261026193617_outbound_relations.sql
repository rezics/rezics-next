-- migrate:up
CREATE TABLE semantic.outbound_link (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  property text NOT NULL CHECK (char_length(property) >= 1),
  filter_value uuid NOT NULL,
  order_key text COLLATE "C" NOT NULL,
  target_subject_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  relation boolean NOT NULL,
  source_type text NOT NULL DEFAULT '',
  source_order_key text COLLATE "C" NOT NULL DEFAULT '',
  outbound_order text,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  source_security_revision bigint NOT NULL DEFAULT 0 CHECK (source_security_revision >= 0),
  target_revision integer NOT NULL DEFAULT 0 CHECK (target_revision >= 0),
  target_type text NOT NULL DEFAULT '',
  external text,
  value text NOT NULL CHECK (value IN ('value', 'somevalue', 'novalue')),
  present boolean NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, property, filter_value, order_key, target_subject_id, statement_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);
CREATE INDEX outbound_link_present ON semantic.outbound_link
  (route, subject_id, property, filter_value, order_key, target_subject_id, statement_id)
  INCLUDE (slot_id) WHERE present;

CREATE TABLE semantic.outbound_link_count (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  property text NOT NULL,
  filter_value uuid NOT NULL,
  value bigint NOT NULL CHECK (value >= 0),
  PRIMARY KEY (route, subject_id, property, filter_value),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);
ALTER TABLE semantic.merge_member DROP CONSTRAINT merge_member_phase_check;
ALTER TABLE semantic.merge_member ADD CONSTRAINT merge_member_phase_check
  CHECK (phase IN ('links', 'outbound', 'members', 'done'));
ALTER TABLE semantic.subject ADD COLUMN projection_pending boolean NOT NULL DEFAULT false;
UPDATE semantic.subject s SET projection_pending = true
FROM semantic.merge_member m
WHERE m.member_id = s.subject_id
  AND s.route = get_byte(uuid_send(m.member_id), 10) * 256 + get_byte(uuid_send(m.member_id), 11)
  AND m.phase <> 'done';

ALTER TABLE semantic.fact ADD COLUMN relation boolean NOT NULL DEFAULT false;
UPDATE semantic.fact fact
SET relation = COALESCE(
  definition.body #>> ARRAY['properties', fact.property, 'relation', 'group'], ''
) IN ('order', 'derivation', 'world', 'membership', 'association', 'credit', 'appearance')
FROM semantic.definition_release definition
WHERE definition.route = 0 AND definition.digest = fact.release
  AND fact.kind = 'statement' AND fact.operation IN ('assert', 'expand');

ALTER TABLE semantic.candidate ADD COLUMN relation boolean NOT NULL DEFAULT false;
UPDATE semantic.candidate candidate
SET relation = COALESCE(
  definition.body #>> ARRAY['properties', candidate.property, 'relation', 'group'], ''
) IN ('order', 'derivation', 'world', 'membership', 'association', 'credit', 'appearance')
FROM semantic.definition_release definition
WHERE definition.route = 0 AND definition.digest = candidate.release;

-- Recalculate the cached descriptive-fact count after relation statements are
-- classified. Existing subjects may have relation statements counted by the
-- previous migration's all-statement calculation.
WITH statement_slots AS (
  SELECT DISTINCT ON (route, subject_id, slot_id)
         route, subject_id, slot_id, operation, relation
  FROM semantic.fact
  WHERE kind = 'statement'
  ORDER BY route, subject_id, slot_id, log_seq DESC
), compact_latest AS (
  SELECT DISTINCT ON (f.route, f.subject_id, f.slot_id, f.statement_id)
         f.route, f.subject_id, f.slot_id, f.statement_id, f.operation, f.body, f.relation
  FROM semantic.fact f
  JOIN statement_slots s
    ON s.route = f.route AND s.subject_id = f.subject_id AND s.slot_id = f.slot_id
  WHERE f.kind = 'statement' AND s.operation <> 'expand'
  ORDER BY f.route, f.subject_id, f.slot_id, f.statement_id, f.log_seq DESC
), term_latest AS (
  SELECT DISTINCT ON (route, subject_id, slot_id)
         route, subject_id, slot_id, operation
  FROM semantic.fact
  WHERE kind IN ('label', 'description')
  ORDER BY route, subject_id, slot_id, log_seq DESC
), alias_latest AS (
  SELECT DISTINCT ON (route, subject_id, slot_id, body)
         route, subject_id, slot_id, body, operation
  FROM semantic.fact
  WHERE kind = 'alias'
  ORDER BY route, subject_id, slot_id, body, log_seq DESC
), term_counts AS (
  SELECT route, subject_id, count(*)::integer AS count
  FROM (
    SELECT route, subject_id FROM term_latest WHERE operation = 'assert'
    UNION ALL
    SELECT route, subject_id FROM alias_latest WHERE operation = 'assert'
  ) current_terms
  GROUP BY route, subject_id
), compact_counts AS (
  SELECT route, subject_id, count(*)::integer AS count
  FROM compact_latest
  WHERE operation = 'assert' AND NOT relation AND body->>'rank' IN ('normal', 'preferred')
  GROUP BY route, subject_id
), global_adoptions AS (
  SELECT DISTINCT ON (a.route, a.subject_id, a.slot_id)
         a.route, a.subject_id, a.slot_id, a.mode, a.selection
  FROM semantic.adoption a
  WHERE a.context_id = '00000000-0000-8000-8000-000000000000'
  ORDER BY a.route, a.subject_id, a.slot_id, a.head DESC
), expanded_counts AS (
  SELECT s.route, s.subject_id,
         sum(CASE WHEN a.mode = 'replace' THEN jsonb_array_length(a.selection) ELSE 0 END)::integer AS count
  FROM statement_slots s
  LEFT JOIN global_adoptions a
    ON a.route = s.route AND a.subject_id = s.subject_id AND a.slot_id = s.slot_id
  WHERE s.operation = 'expand' AND NOT s.relation
  GROUP BY s.route, s.subject_id
), current_counts AS (
  SELECT s.route, s.subject_id,
         COALESCE(t.count, 0) + COALESCE(c.count, 0) + COALESCE(e.count, 0) AS count
  FROM semantic.subject s
  LEFT JOIN term_counts t ON t.route = s.route AND t.subject_id = s.subject_id
  LEFT JOIN compact_counts c ON c.route = s.route AND c.subject_id = s.subject_id
  LEFT JOIN expanded_counts e ON e.route = s.route AND e.subject_id = s.subject_id
)
UPDATE semantic.subject s
SET current_facts = current_counts.count
FROM current_counts
WHERE current_counts.route = s.route AND current_counts.subject_id = s.subject_id;

-- migrate:down
ALTER TABLE semantic.merge_member DROP CONSTRAINT merge_member_phase_check;
ALTER TABLE semantic.merge_member ADD CONSTRAINT merge_member_phase_check CHECK (phase IN ('links', 'members', 'done'));
ALTER TABLE semantic.subject DROP COLUMN projection_pending;
DROP TABLE semantic.outbound_link_count;
DROP TABLE semantic.outbound_link;
ALTER TABLE semantic.candidate DROP COLUMN relation;
ALTER TABLE semantic.fact DROP COLUMN relation;
