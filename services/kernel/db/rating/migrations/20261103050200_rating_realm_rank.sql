-- migrate:up
-- Publication and this private projection commit together in the subject home.
LOCK TABLE rating.public_figure IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE rating.realm_rank (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  question_id uuid NOT NULL,
  population_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  count bigint NOT NULL CHECK (count >= 5),
  mean numeric(12,4) NOT NULL,
  score numeric(12,4) NOT NULL,
  prior_epoch integer NOT NULL,
  prior_generation bigint NOT NULL,
  revision bigint NOT NULL,
  as_of timestamptz NOT NULL,
  PRIMARY KEY (partition_no, question_id, population_id, subject_id),
  CHECK (partition_no = (get_byte(uuid_send(subject_id),10)*256 + get_byte(uuid_send(subject_id),11)) >> 4)
);
CREATE INDEX realm_rank_score_idx ON rating.realm_rank
  (partition_no, question_id, population_id, prior_generation, score DESC, subject_id DESC);

CREATE TABLE rating.realm_rank_generation (
  partition_no integer NOT NULL,
  question_id uuid NOT NULL,
  population_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  PRIMARY KEY (partition_no, question_id, population_id)
);

CREATE FUNCTION rating.publish_realm_rank() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.population_id <> '00000000-0000-8000-8000-000000000000'::uuid
     AND NEW.score IS NOT NULL AND NEW.as_of IS NOT NULL THEN
    INSERT INTO rating.realm_rank
      (partition_no,question_id,population_id,subject_id,count,mean,score,prior_epoch,prior_generation,revision,as_of)
    VALUES (NEW.partition_no,NEW.question_id,NEW.population_id,NEW.subject_id,NEW.count,NEW.mean,NEW.score,
            NEW.prior_epoch,NEW.published_prior_generation,NEW.revision,NEW.as_of)
    ON CONFLICT (partition_no,question_id,population_id,subject_id) DO UPDATE
      SET count=EXCLUDED.count,mean=EXCLUDED.mean,score=EXCLUDED.score,prior_epoch=EXCLUDED.prior_epoch,
          prior_generation=EXCLUDED.prior_generation,revision=EXCLUDED.revision,as_of=EXCLUDED.as_of
      WHERE (realm_rank.count,realm_rank.mean,realm_rank.score,realm_rank.prior_epoch,
             realm_rank.prior_generation,realm_rank.revision,realm_rank.as_of)
        IS DISTINCT FROM (EXCLUDED.count,EXCLUDED.mean,EXCLUDED.score,EXCLUDED.prior_epoch,
                          EXCLUDED.prior_generation,EXCLUDED.revision,EXCLUDED.as_of);
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

INSERT INTO rating.realm_rank
  (partition_no,question_id,population_id,subject_id,count,mean,score,prior_epoch,prior_generation,revision,as_of)
SELECT partition_no,question_id,population_id,subject_id,count,mean,score,prior_epoch,
       published_prior_generation,revision,as_of FROM rating.public_figure
WHERE population_id <> '00000000-0000-8000-8000-000000000000'::uuid AND score IS NOT NULL AND as_of IS NOT NULL;
INSERT INTO rating.realm_rank_generation
SELECT DISTINCT partition_no,question_id,population_id,1 FROM rating.realm_rank;
CREATE TRIGGER public_figure_realm_rank AFTER INSERT OR UPDATE OR DELETE ON rating.public_figure
  FOR EACH ROW EXECUTE FUNCTION rating.publish_realm_rank();

-- migrate:down
-- Forward only: private rank generation identities must not be reused.
SELECT 1;
