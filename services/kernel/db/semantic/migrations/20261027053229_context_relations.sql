-- migrate:up
ALTER TABLE semantic.inbound_link
  ADD COLUMN context_id uuid NOT NULL DEFAULT '00000000-0000-8000-8000-000000000000',
  ADD COLUMN suppressed boolean NOT NULL DEFAULT false;
ALTER TABLE semantic.inbound_link DROP CONSTRAINT inbound_link_pkey;
ALTER TABLE semantic.inbound_link ADD PRIMARY KEY (route, subject_id, context_id, property, source_subject_id, statement_id, filter_value);
ALTER TABLE semantic.inbound_link_count ADD COLUMN context_id uuid NOT NULL DEFAULT '00000000-0000-8000-8000-000000000000';
ALTER TABLE semantic.inbound_link_count ADD CHECK (context_id = '00000000-0000-8000-8000-000000000000');
CREATE TABLE semantic.inbound_link_context_count (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  context_id uuid NOT NULL CHECK (context_id <> '00000000-0000-8000-8000-000000000000'),
  property text NOT NULL,
  filter_value uuid NOT NULL,
  value bigint NOT NULL,
  PRIMARY KEY (route, subject_id, context_id, property, filter_value),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);
DROP INDEX semantic.inbound_link_present;
CREATE INDEX inbound_link_present ON semantic.inbound_link
  (route, subject_id, context_id, property, filter_value, order_key, source_subject_id, statement_id) INCLUDE (source_type, suppressed) WHERE present;
ALTER TABLE semantic.outbound_link
  ADD COLUMN context_id uuid NOT NULL DEFAULT '00000000-0000-8000-8000-000000000000',
  ADD COLUMN suppressed boolean NOT NULL DEFAULT false;
ALTER TABLE semantic.outbound_link DROP CONSTRAINT outbound_link_pkey;
ALTER TABLE semantic.outbound_link ADD PRIMARY KEY (route, subject_id, context_id, property, filter_value, order_key, target_subject_id, statement_id);
ALTER TABLE semantic.outbound_link_count ADD COLUMN context_id uuid NOT NULL DEFAULT '00000000-0000-8000-8000-000000000000';
ALTER TABLE semantic.outbound_link_count ADD CHECK (context_id = '00000000-0000-8000-8000-000000000000');
CREATE TABLE semantic.outbound_link_context_count (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  context_id uuid NOT NULL CHECK (context_id <> '00000000-0000-8000-8000-000000000000'),
  property text NOT NULL,
  filter_value uuid NOT NULL,
  value bigint NOT NULL,
  PRIMARY KEY (route, subject_id, context_id, property, filter_value),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);
DROP INDEX semantic.outbound_link_present;
CREATE INDEX outbound_link_present ON semantic.outbound_link
  (route, subject_id, context_id, property, filter_value, order_key, target_subject_id, statement_id) INCLUDE (relation, target_type, suppressed) WHERE present;
DROP INDEX semantic.inbound_link_all_present;
CREATE INDEX inbound_link_all_present ON semantic.inbound_link
  (route, subject_id, context_id, property, source_subject_id, statement_id) INCLUDE (source_type, suppressed)
  WHERE present AND filter_value = '00000000-0000-0000-0000-000000000000';
CREATE INDEX outbound_link_statement ON semantic.outbound_link
  (route, subject_id, context_id, property, filter_value, statement_id, source_revision DESC, source_security_revision DESC, target_revision DESC);
DROP INDEX semantic.inbound_link_key_reemit;
CREATE INDEX inbound_link_key_reemit ON semantic.inbound_link
  (route, subject_id, property, source_subject_id, statement_id, filter_value, context_id) WHERE present;
DROP INDEX semantic.outbound_link_key_reemit;
CREATE INDEX outbound_link_key_reemit ON semantic.outbound_link
  (route, subject_id, property, target_subject_id, statement_id, filter_value, context_id) WHERE present AND relation;
DROP INDEX semantic.outbound_link_identity;
CREATE INDEX outbound_link_identity ON semantic.outbound_link
  (route, subject_id, context_id, property, statement_id, filter_value) WHERE present;
CREATE INDEX outbound_link_maintenance ON semantic.outbound_link
  (route, subject_id, property, target_subject_id, statement_id, filter_value, context_id) WHERE present;
CREATE TABLE semantic.relation_context_slot (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  context_id uuid NOT NULL CHECK (context_id <> '00000000-0000-8000-8000-000000000000'),
  PRIMARY KEY (route, subject_id, slot_id, context_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);
INSERT INTO semantic.relation_context_slot(route, subject_id, slot_id, context_id)
SELECT route, subject_id, slot_id, context_id FROM semantic.adoption WHERE context_id <> '00000000-0000-8000-8000-000000000000'
UNION SELECT route, subject_id, slot_id, context_id FROM semantic.acceptance_current WHERE context_id <> '00000000-0000-8000-8000-000000000000';
CREATE INDEX inbound_link_context_overrides ON semantic.inbound_link
  (route, subject_id, property, filter_value, statement_id, source_subject_id, context_id)
  WHERE present AND context_id <> '00000000-0000-8000-8000-000000000000';
CREATE INDEX outbound_link_context_overrides ON semantic.outbound_link
  (route, subject_id, property, filter_value, statement_id, target_subject_id, context_id)
  WHERE present AND context_id <> '00000000-0000-8000-8000-000000000000';
-- migrate:down
DROP TABLE semantic.relation_context_slot;
DELETE FROM semantic.inbound_link WHERE context_id <> '00000000-0000-8000-8000-000000000000';
ALTER TABLE semantic.inbound_link DROP CONSTRAINT inbound_link_pkey;
ALTER TABLE semantic.inbound_link ADD PRIMARY KEY (route, subject_id, property, source_subject_id, statement_id, filter_value);
DROP TABLE semantic.inbound_link_context_count;
ALTER TABLE semantic.inbound_link_count DROP COLUMN context_id;
ALTER TABLE semantic.inbound_link DROP COLUMN context_id, DROP COLUMN suppressed;
DELETE FROM semantic.outbound_link WHERE context_id <> '00000000-0000-8000-8000-000000000000';
ALTER TABLE semantic.outbound_link DROP CONSTRAINT outbound_link_pkey;
ALTER TABLE semantic.outbound_link ADD PRIMARY KEY (route, subject_id, property, filter_value, order_key, target_subject_id, statement_id);
DROP TABLE semantic.outbound_link_context_count;
ALTER TABLE semantic.outbound_link_count DROP COLUMN context_id;
ALTER TABLE semantic.outbound_link DROP COLUMN context_id, DROP COLUMN suppressed;
DROP INDEX IF EXISTS semantic.inbound_link_context_overrides;
DROP INDEX IF EXISTS semantic.outbound_link_context_overrides;
DROP INDEX IF EXISTS semantic.outbound_link_maintenance;
CREATE INDEX inbound_link_present ON semantic.inbound_link
  (route, subject_id, property, filter_value, order_key, source_subject_id, statement_id) WHERE present;
CREATE INDEX inbound_link_all_present ON semantic.inbound_link
  (route, subject_id, property, source_subject_id, statement_id)
  WHERE present AND filter_value = '00000000-0000-0000-0000-000000000000';
CREATE INDEX outbound_link_present ON semantic.outbound_link
  (route, subject_id, property, filter_value, order_key, target_subject_id, statement_id) INCLUDE (slot_id) WHERE present;
CREATE INDEX inbound_link_key_reemit ON semantic.inbound_link
  (route, subject_id, property, source_subject_id, statement_id, filter_value) WHERE present;
CREATE INDEX outbound_link_key_reemit ON semantic.outbound_link
  (route, subject_id, property, target_subject_id, statement_id, filter_value) WHERE present AND relation;
CREATE INDEX outbound_link_identity ON semantic.outbound_link
  (route, subject_id, property, statement_id, filter_value) WHERE present;
