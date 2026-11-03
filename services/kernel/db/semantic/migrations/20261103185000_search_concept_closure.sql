-- migrate:up
CREATE INDEX search_selected_concept_broader
  ON semantic.search_selected USING btree (
    property,
    (((body -> 'value'::text) ->> 'content'::text) COLLATE "C"),
    route,
    subject_id,
    slot_id,
    candidate_id
  )
  WHERE active AND relation AND ((body -> 'value'::text) ->> 'type'::text) = 'value'::text;

CREATE TRIGGER statement_disclosure_search_canonical_generation
  AFTER INSERT OR DELETE OR UPDATE ON semantic.statement_disclosure
  FOR EACH ROW EXECUTE FUNCTION semantic.bump_search_canonical_generation();

-- migrate:down
DROP TRIGGER statement_disclosure_search_canonical_generation ON semantic.statement_disclosure;
DROP INDEX semantic.search_selected_concept_broader;
