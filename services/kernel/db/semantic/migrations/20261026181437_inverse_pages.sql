-- migrate:up
ALTER TABLE semantic.inbound_link
  ADD COLUMN source_type text NOT NULL DEFAULT '',
  ADD COLUMN order_key text COLLATE "C" NOT NULL DEFAULT '',
  ADD COLUMN filter_value uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE semantic.inbound_link DROP CONSTRAINT inbound_link_pkey;
ALTER TABLE semantic.inbound_link ADD PRIMARY KEY (route, subject_id, property, source_subject_id, statement_id, filter_value);
DROP INDEX semantic.inbound_link_present;
CREATE INDEX inbound_link_present ON semantic.inbound_link
  (route, subject_id, property, filter_value, order_key, source_subject_id, statement_id) WHERE present;
CREATE INDEX inbound_link_all_present ON semantic.inbound_link
  (route, subject_id, property, source_subject_id, statement_id)
  WHERE present AND filter_value = '00000000-0000-0000-0000-000000000000';
CREATE TABLE semantic.inbound_link_count (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  property text NOT NULL,
  filter_value uuid NOT NULL,
  value bigint NOT NULL CHECK (value >= 0),
  PRIMARY KEY (route, subject_id, property, filter_value),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);
INSERT INTO semantic.inbound_link_count
SELECT route, subject_id, property, filter_value, count(*) FROM semantic.inbound_link WHERE present
GROUP BY route, subject_id, property, filter_value;

ALTER TABLE semantic.revision DROP CONSTRAINT revision_kind_check;
ALTER TABLE semantic.revision ADD CONSTRAINT revision_kind_check CHECK (kind IN ('create','propose','accept','reject','adopt','merge','retract','identity'));

-- migrate:down
DELETE FROM semantic.revision WHERE kind = 'identity';
ALTER TABLE semantic.revision DROP CONSTRAINT revision_kind_check;
ALTER TABLE semantic.revision ADD CONSTRAINT revision_kind_check CHECK (kind IN ('create','propose','accept','reject','adopt','merge','retract'));
DROP TABLE semantic.inbound_link_count;
DROP INDEX semantic.inbound_link_all_present;
DROP INDEX semantic.inbound_link_present;
DELETE FROM semantic.inbound_link WHERE filter_value <> '00000000-0000-0000-0000-000000000000';
ALTER TABLE semantic.inbound_link DROP CONSTRAINT inbound_link_pkey;
ALTER TABLE semantic.inbound_link DROP COLUMN source_type, DROP COLUMN order_key, DROP COLUMN filter_value;
ALTER TABLE semantic.inbound_link ADD PRIMARY KEY (route, subject_id, property, source_subject_id, statement_id);
CREATE INDEX inbound_link_present ON semantic.inbound_link (route, subject_id, property, source_subject_id, statement_id) WHERE present;
