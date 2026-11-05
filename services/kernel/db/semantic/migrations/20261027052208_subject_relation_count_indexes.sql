-- migrate:up
CREATE INDEX inbound_link_count_unfiltered ON semantic.inbound_link_count
  (route, subject_id, property) INCLUDE (value)
  WHERE filter_value = '00000000-0000-0000-0000-000000000000'::uuid AND value > 0;
CREATE INDEX outbound_link_count_unfiltered ON semantic.outbound_link_count
  (route, subject_id, property) INCLUDE (value)
  WHERE filter_value = '00000000-0000-0000-0000-000000000000'::uuid AND value > 0;

-- migrate:down
DROP INDEX semantic.inbound_link_count_unfiltered;
DROP INDEX semantic.outbound_link_count_unfiltered;
