-- migrate:up
-- A single O(1) observation changes with every source transition that can change canonical Search names or identity.
CREATE SEQUENCE semantic.search_canonical_generation START WITH 1;

CREATE FUNCTION semantic.bump_search_canonical_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nextval('semantic.search_canonical_generation');
  RETURN NULL;
END;
$$;

CREATE TRIGGER subject_search_canonical_generation
AFTER INSERT OR UPDATE OR DELETE ON semantic.subject
FOR EACH ROW EXECUTE FUNCTION semantic.bump_search_canonical_generation();

CREATE TRIGGER redirect_search_canonical_generation
AFTER INSERT OR UPDATE OR DELETE ON semantic.redirect
FOR EACH ROW EXECUTE FUNCTION semantic.bump_search_canonical_generation();

CREATE TRIGGER selected_fact_search_canonical_generation
AFTER INSERT OR UPDATE OR DELETE ON semantic.search_selected
FOR EACH ROW EXECUTE FUNCTION semantic.bump_search_canonical_generation();

CREATE TRIGGER selection_state_search_canonical_generation
AFTER INSERT OR UPDATE OR DELETE ON semantic.search_selection_state
FOR EACH ROW EXECUTE FUNCTION semantic.bump_search_canonical_generation();

CREATE TRIGGER page_publication_search_canonical_generation
AFTER INSERT OR UPDATE OR DELETE ON semantic.subject_page_publication
FOR EACH ROW EXECUTE FUNCTION semantic.bump_search_canonical_generation();

-- migrate:down
DROP TRIGGER page_publication_search_canonical_generation ON semantic.subject_page_publication;
DROP TRIGGER selection_state_search_canonical_generation ON semantic.search_selection_state;
DROP TRIGGER selected_fact_search_canonical_generation ON semantic.search_selected;
DROP TRIGGER redirect_search_canonical_generation ON semantic.redirect;
DROP TRIGGER subject_search_canonical_generation ON semantic.subject;
DROP FUNCTION semantic.bump_search_canonical_generation();
DROP SEQUENCE semantic.search_canonical_generation;
