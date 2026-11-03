-- migrate:up
-- A global observation token lets Search detect any published rank change without reading every home.
CREATE SEQUENCE rating.realm_rank_publication_generation START WITH 1;

CREATE FUNCTION rating.bump_realm_rank_publication_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nextval('rating.realm_rank_publication_generation');
  RETURN NULL;
END;
$$;

CREATE TRIGGER realm_rank_publication_generation
AFTER INSERT OR UPDATE OR DELETE ON rating.realm_rank_generation
FOR EACH ROW EXECUTE FUNCTION rating.bump_realm_rank_publication_generation();

CREATE INDEX realm_rank_generation_population_idx
ON rating.realm_rank_generation(question_id,population_id,partition_no);

-- migrate:down
DROP INDEX rating.realm_rank_generation_population_idx;
DROP TRIGGER realm_rank_publication_generation ON rating.realm_rank_generation;
DROP FUNCTION rating.bump_realm_rank_publication_generation();
DROP SEQUENCE rating.realm_rank_publication_generation;
