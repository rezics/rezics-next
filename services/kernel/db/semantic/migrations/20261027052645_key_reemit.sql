-- migrate:up
CREATE INDEX outbound_link_key_reemit ON semantic.outbound_link
  (route, subject_id, property, target_subject_id, statement_id, filter_value)
  WHERE present AND relation;

CREATE INDEX inbound_link_key_reemit ON semantic.inbound_link
  (route, subject_id, property, source_subject_id, statement_id, filter_value)
  WHERE present;

-- Display keys can change; old-row probes use only the stable identity.
CREATE INDEX outbound_link_identity ON semantic.outbound_link
  (route, subject_id, property, statement_id, filter_value)
  WHERE present;

-- migrate:down
DROP INDEX semantic.outbound_link_identity;
DROP INDEX semantic.inbound_link_key_reemit;
DROP INDEX semantic.outbound_link_key_reemit;
