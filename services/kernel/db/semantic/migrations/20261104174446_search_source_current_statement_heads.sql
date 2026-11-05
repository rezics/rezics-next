-- migrate:up
CREATE INDEX search_selected_nonrelation_page
  ON semantic.search_selected (route, subject_id, property, slot_id, candidate_id)
  WHERE active AND relation IS FALSE;

-- migrate:down
DROP INDEX semantic.search_selected_nonrelation_page;
