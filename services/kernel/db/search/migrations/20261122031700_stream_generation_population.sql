-- migrate:up
-- Ordinary prepared lists have a bounded population. Only an enrolled native generation
-- may extend a private segmented build beyond that bound.
ALTER TABLE search.public_filter_prepared
  ADD COLUMN population_job uuid,
  ADD COLUMN population_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN verified_raw integer NOT NULL DEFAULT 0 CHECK (verified_raw >= 0),
  ADD COLUMN verified_output integer NOT NULL DEFAULT 0 CHECK (verified_output BETWEEN 0 AND verified_raw),
  ADD CONSTRAINT public_filter_prepared_population_job_fkey FOREIGN KEY (partition_no,population_job)
    REFERENCES search.generation_publication(partition_no,job),
  DROP CONSTRAINT public_filter_prepared_raw_count_check,
  ADD CONSTRAINT public_filter_prepared_raw_count_check CHECK (raw_count >= 0 AND (population_job IS NOT NULL OR raw_count <= 1000));
ALTER TABLE search.public_filter_preparation_segment
  DROP CONSTRAINT public_filter_preparation_segment_raw_ordinal_check,
  DROP CONSTRAINT public_filter_preparation_segment_output_ordinal_check,
  ADD CONSTRAINT public_filter_preparation_segment_raw_ordinal_check CHECK (raw_ordinal >= 0),
  ADD CONSTRAINT public_filter_preparation_segment_output_ordinal_check CHECK (output_ordinal >= 0);

-- The writer holds the original target's admission lock. The Source cut, registration,
-- generation and exact physical incarnation must still precede every public pin.
CREATE FUNCTION search.private_population_build(original_job uuid, original_registration text,
  original_build text, original_consumer jsonb) RETURNS boolean STABLE LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT FROM search.generation_publication j
    JOIN search.public_filter_target t ON (t.partition_no,t.physical_target,t.incarnation)=
      (j.partition_no,j.physical_target,j.native_incarnation)
    JOIN search.public_filter_registration r ON (r.partition_no,r.physical_target)=(t.partition_no,t.physical_target)
    JOIN semantic.public_filter_bootstrap b ON b.partition_no=j.partition_no AND b.bootstrap=substring(original_build FROM 3)::uuid
    JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.owner_epoch AND p.write_state='active'
    WHERE (j.partition_no,j.job)=(0,original_job) AND j.phase='reconciled' AND j.source_home=0
      AND j.consumer=original_consumer AND j.binding->>'readDefinition'=b.read_definition::text
      AND j.fence IS NULL AND j.bootstrap IS NULL AND j.queried IS NULL AND j.observation IS NULL AND j.execution IS NULL
      AND r.id=original_registration AND r.state='active' AND r.consumer_bootstrap=original_build AND r.consumer_work IS NOT NULL
      AND original_build='0:'||b.bootstrap::text AND b.snapshot_kind='prepared' AND b.state='begun' AND b.queried IS NULL
      AND b.coverage_publication IS NULL AND b.publication_job IS NULL AND b.publication_observation IS NULL
      AND b.publication_execution IS NULL AND b.account_after=4096 AND b.coverage_after=4096
      AND b.coverage_sealed AND b.coverage_root IS NOT NULL AND b.coverage_generation IS NOT NULL
  )
$$;


CREATE FUNCTION search.require_generation_population_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT FROM (SELECT DISTINCT partition_no,registration,build,generation FROM appended
                  WHERE raw_ordinal>=1000 OR output_ordinal>=1000) a
    WHERE NOT EXISTS (SELECT FROM search.public_filter_prepared p
      WHERE (p.partition_no,p.registration,p.build,p.generation)=(a.partition_no,a.registration,a.build,a.generation)
        AND p.population_job IS NOT NULL AND p.state='active' AND p.segment_state='building'
        AND NOT p.raw_exhausted FOR SHARE OF p)
  ) THEN
    RAISE EXCEPTION 'A wide prepared segment requires its original private generation build' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER generation_population_append AFTER INSERT ON search.public_filter_preparation_segment
  REFERENCING NEW TABLE AS appended FOR EACH STATEMENT EXECUTE FUNCTION search.require_generation_population_batch();
CREATE TRIGGER generation_population_update AFTER UPDATE ON search.public_filter_preparation_segment
  REFERENCING NEW TABLE AS appended FOR EACH STATEMENT EXECUTE FUNCTION search.require_generation_population_batch();


-- Verification spans bounded transactions. A changed previously verified ordinal
-- invalidates the original proof in the same commit, including a concurrent finalization.
CREATE FUNCTION search.invalidate_population_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE search.public_filter_prepared p
     SET verified_raw=0,verified_output=0,population_verified=false,segment_state='building'
    FROM (SELECT partition_no,registration,build,generation,min(raw_ordinal) AS changed
            FROM original_segments GROUP BY partition_no,registration,build,generation) s
   WHERE (p.partition_no,p.registration,p.build,p.generation)=(s.partition_no,s.registration,s.build,s.generation)
     AND p.population_job IS NOT NULL AND p.raw_exhausted AND p.state='active'
     AND p.segment_state IN ('building','complete') AND p.verified_raw>s.changed;
  RETURN NULL;
END
$$;
CREATE TRIGGER invalidate_deleted_population_ordinals AFTER DELETE ON search.public_filter_preparation_segment
  REFERENCING OLD TABLE AS original_segments FOR EACH STATEMENT EXECUTE FUNCTION search.invalidate_population_verification();
CREATE TRIGGER invalidate_updated_population_ordinals AFTER UPDATE ON search.public_filter_preparation_segment
  REFERENCING OLD TABLE AS original_segments FOR EACH STATEMENT EXECUTE FUNCTION search.invalidate_population_verification();


-- migrate:down
LOCK TABLE search.public_filter_prepared,search.public_filter_preparation_segment IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT FROM search.public_filter_prepared WHERE raw_count>1000)
    OR EXISTS (SELECT FROM search.public_filter_preparation_segment WHERE raw_ordinal>=1000 OR output_ordinal>=1000) THEN
    RAISE EXCEPTION 'A wide retained generation still requires bounded ordinal verification';
  END IF;
END
$$;
DROP TRIGGER generation_population_append ON search.public_filter_preparation_segment;
DROP TRIGGER generation_population_update ON search.public_filter_preparation_segment;
DROP FUNCTION search.require_generation_population_batch();
DROP TRIGGER invalidate_deleted_population_ordinals ON search.public_filter_preparation_segment;
DROP TRIGGER invalidate_updated_population_ordinals ON search.public_filter_preparation_segment;
DROP FUNCTION search.invalidate_population_verification();

-- The old reader cannot represent any wide retained original. Restore its checks atomically.
ALTER TABLE search.public_filter_prepared
  DROP CONSTRAINT public_filter_prepared_raw_count_check,
  ADD CONSTRAINT public_filter_prepared_raw_count_check CHECK (raw_count BETWEEN 0 AND 1000);
ALTER TABLE search.public_filter_preparation_segment
  DROP CONSTRAINT public_filter_preparation_segment_raw_ordinal_check,
  DROP CONSTRAINT public_filter_preparation_segment_output_ordinal_check,
  ADD CONSTRAINT public_filter_preparation_segment_raw_ordinal_check CHECK (raw_ordinal BETWEEN 0 AND 999),
  ADD CONSTRAINT public_filter_preparation_segment_output_ordinal_check CHECK (output_ordinal BETWEEN 0 AND 999);
DROP FUNCTION search.private_population_build(uuid,text,text,jsonb);
ALTER TABLE search.public_filter_prepared DROP COLUMN population_verified,DROP COLUMN verified_output, DROP COLUMN verified_raw, DROP COLUMN population_job;
