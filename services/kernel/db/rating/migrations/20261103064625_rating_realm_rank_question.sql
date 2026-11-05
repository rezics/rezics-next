-- migrate:up
-- Freeze the measurement alongside published values and the population-home prior.
LOCK TABLE rating.public_figure IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE rating.public_figure ADD COLUMN question_identity text DEFAULT '[1,"work",0,20,1]';
ALTER TABLE rating.population_prior_epoch ADD COLUMN question_identity text DEFAULT '[1,"work",0,20,1]';
ALTER TABLE rating.subject_home_prior_input ADD COLUMN question_identity text DEFAULT '[1,"work",0,20,1]';
ALTER TABLE rating.realm_rank ADD COLUMN question_identity text NOT NULL DEFAULT '[1,"work",0,20,1]';
DROP INDEX rating.realm_rank_score_idx;
CREATE INDEX realm_rank_score_idx ON rating.realm_rank
  (partition_no, question_id, population_id, question_identity, prior_generation, score DESC, subject_id DESC);

CREATE OR REPLACE FUNCTION rating.publish_realm_rank() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.population_id <> '00000000-0000-8000-8000-000000000000'::uuid
     AND NEW.score IS NOT NULL AND NEW.as_of IS NOT NULL THEN
    INSERT INTO rating.realm_rank
      (partition_no,question_id,population_id,subject_id,count,mean,score,prior_epoch,prior_generation,revision,as_of,question_identity)
    VALUES (NEW.partition_no,NEW.question_id,NEW.population_id,NEW.subject_id,NEW.count,NEW.mean,NEW.score,
            NEW.prior_epoch,NEW.published_prior_generation,NEW.revision,NEW.as_of,NEW.question_identity)
    ON CONFLICT (partition_no,question_id,population_id,subject_id) DO UPDATE
      SET count=EXCLUDED.count,mean=EXCLUDED.mean,score=EXCLUDED.score,prior_epoch=EXCLUDED.prior_epoch,
          prior_generation=EXCLUDED.prior_generation,revision=EXCLUDED.revision,as_of=EXCLUDED.as_of,question_identity=EXCLUDED.question_identity
      WHERE (realm_rank.count,realm_rank.mean,realm_rank.score,realm_rank.prior_epoch,
             realm_rank.prior_generation,realm_rank.revision,realm_rank.as_of,realm_rank.question_identity)
        IS DISTINCT FROM (EXCLUDED.count,EXCLUDED.mean,EXCLUDED.score,EXCLUDED.prior_epoch,
                          EXCLUDED.prior_generation,EXCLUDED.revision,EXCLUDED.as_of,EXCLUDED.question_identity);
  ELSE
    DELETE FROM rating.realm_rank
      WHERE partition_no=OLD.partition_no AND question_id=OLD.question_id
        AND population_id=OLD.population_id AND subject_id=OLD.subject_id;
  END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed > 0 THEN
    INSERT INTO rating.realm_rank_generation(partition_no,question_id,population_id,generation)
    VALUES (COALESCE(NEW.partition_no,OLD.partition_no),COALESCE(NEW.question_id,OLD.question_id),
            COALESCE(NEW.population_id,OLD.population_id),1)
    ON CONFLICT (partition_no,question_id,population_id) DO UPDATE
      SET generation=realm_rank_generation.generation+1;
  END IF;
  RETURN NULL;
END;
$$;

-- Existing totals enter the same native prior check and bounded republish pages on worker startup.
UPDATE rating.population_total_component SET needs_epoch_check = true
WHERE question_id <> '00000000-0000-7000-8000-000000000001'::uuid
  AND population_id <> '00000000-0000-8000-8000-000000000000'::uuid;

-- migrate:down
-- Forward only: question and scale identities must remain attached to published values.
SELECT 1;
