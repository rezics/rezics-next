-- Widen native storage to the bounded question-scale delivery contract. Existing rows remain unchanged.
ALTER TABLE rating.vote DROP CONSTRAINT vote_units_check;
ALTER TABLE rating.vote ADD CONSTRAINT vote_units_check
  CHECK (units IS NULL OR units BETWEEN 0 AND 4096);

ALTER TABLE rating.population_vote DROP CONSTRAINT population_vote_units_check;
ALTER TABLE rating.population_vote ADD CONSTRAINT population_vote_units_check
  CHECK (units IS NULL OR units BETWEEN 0 AND 4096);

ALTER TABLE rating.question DROP CONSTRAINT question_realm_definition_check;
ALTER TABLE rating.question ADD CONSTRAINT question_realm_definition_check CHECK (
  (realm_id IS NULL AND meaning IS NULL) OR
  (realm_id IS NOT NULL AND owner_id IS NOT NULL AND meaning IS NOT NULL
   AND char_length(btrim(meaning)) BETWEEN 1 AND 2000
   AND char_length(btrim(label)) BETWEEN 1 AND 200
   AND minimum_units >= 0 AND maximum_units <= 4096 AND maximum_units > minimum_units
   AND get_byte(uuid_send(id), 10) = get_byte(uuid_send(realm_id), 10)
   AND get_byte(uuid_send(id), 11) = get_byte(uuid_send(realm_id), 11))
);

-- migrate:down
-- Forward only: durable votes may already use the widened stored-unit range.
