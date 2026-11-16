-- migrate:up
ALTER TABLE semantic.public_filter_bootstrap
  ADD COLUMN coverage_publication uuid,
  ADD CONSTRAINT public_filter_bootstrap_publication_coverage_check
    CHECK (coverage_publication IS NULL OR
      (coverage_generation IS NOT NULL AND coverage_after=0 AND account_after=0
       AND NOT coverage_sealed AND coverage_root IS NULL AND publication_job IS NULL));

CREATE UNIQUE INDEX public_filter_bootstrap_publication_capture
  ON semantic.public_filter_bootstrap (partition_no, request_key)
  WHERE state='begun' AND coverage_publication IS NOT NULL;

CREATE INDEX generation_publication_subject_coverage
  ON search.generation_publication (partition_no, physical_target, native_incarnation)
  WHERE family='subjects' AND phase='active';

CREATE INDEX public_filter_observation_covered
  ON search.public_filter_observation (partition_no, registration, md5(covered), prepared_build)
  WHERE state='open';

CREATE FUNCTION semantic.retain_public_filter_publication_coverage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coverage_publication IS DISTINCT FROM OLD.coverage_publication THEN
    RAISE EXCEPTION 'Original publication coverage binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER public_filter_bootstrap_publication_coverage_immutable
  BEFORE UPDATE ON semantic.public_filter_bootstrap FOR EACH ROW
  EXECUTE FUNCTION semantic.retain_public_filter_publication_coverage();

CREATE FUNCTION semantic.public_filter_published_coverage(
  physical_target text, incarnation text, child_definition uuid, publication_job uuid, text_keys text[]
) RETURNS TABLE (
  job uuid, bootstrap uuid, registration text, definition uuid, consumer text,
  generation bigint, covered_generation bigint, coverage_root text, coverage_keys text[]
)
LANGUAGE sql STABLE AS $$
WITH candidates AS MATERIALIZED (
  SELECT j.* FROM search.generation_publication j
  WHERE j.partition_no=0 AND j.physical_target=$1 AND j.native_incarnation=$2
    AND j.family='subjects' AND j.phase='active' AND j.fence IS NULL
    AND ($4 IS NULL OR j.job=$4)
  LIMIT 2
)
SELECT j.job,b.bootstrap,r.id,d.read_definition,r.consumer,r.coverage_generation,b.coverage_generation,
       b.coverage_root,d.coverage_keys
FROM candidates j
JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.publication_job)=(0,j.job)
  AND j.bootstrap='0:'||b.bootstrap::text AND j.observation=b.publication_observation
  AND j.execution=b.publication_execution AND b.queried=j.observation AND b.state='adopted'
  AND b.snapshot_kind='prepared' AND b.coverage_sealed AND b.coverage_after=4096 AND b.account_after=4096
JOIN semantic.public_filter_repair_step seal ON
  (seal.partition_no,seal.bootstrap,seal.execution)=(0,b.bootstrap,b.publication_execution)
  AND seal.verified_root IS NOT NULL AND seal.verified_next IS NULL AND seal.complete AND seal.ack_after=4096
JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(0,j.observation)
  AND o.consumer_bootstrap=j.bootstrap AND o.prepared_build=j.bootstrap AND o.state='open'
  AND o.expires_at>extract(epoch FROM statement_timestamp())*1000
JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(0,o.registration)
  AND r.physical_target=j.physical_target AND r.state='active'
JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(0,r.physical_target)
  AND t.incarnation=j.native_incarnation
JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(0,b.read_definition)
  AND d.read_definition::text=j.binding->>'readDefinition' AND d.release_digest=j.consumer->>'meaningDigest'
JOIN semantic.public_filter_read_definition child ON (child.partition_no,child.read_definition)=(0,$3)
  AND (child.source_id,child.configuration,child.release_digest)=(d.source_id,d.configuration,d.release_digest)
  AND child.coverage_keys IS NOT NULL
JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(0,d.source_id,d.configuration)
JOIN core.partition p ON p.partition_no=0 AND p.epoch=b.owner_epoch AND s.owner_epoch=p.epoch AND p.write_state='active'
JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=(0,r.id,b.bootstrap)
  AND c.population_protocol=1 AND c.after_home=4096 AND c.generation=b.coverage_generation
  AND c.root=b.coverage_root AND c.definition=d.read_definition AND c.consumer=r.consumer
JOIN search.public_filter_coverage_baseline last_home ON
  (last_home.partition_no,last_home.registration,last_home.bootstrap,last_home.source_home)=(0,r.id,b.bootstrap,4095)
  AND last_home.root=c.root
WHERE (SELECT count(*) FROM candidates)=1
  AND '["scope","catalogue-text"]'=ANY(d.coverage_keys)
  AND child.coverage_keys <@ (d.coverage_keys || $5)
$$;

-- migrate:down
DROP FUNCTION semantic.public_filter_published_coverage(text,text,uuid,uuid,text[]);
DROP TRIGGER public_filter_bootstrap_publication_coverage_immutable ON semantic.public_filter_bootstrap;
DROP FUNCTION semantic.retain_public_filter_publication_coverage();
DROP INDEX search.public_filter_observation_covered;
DROP INDEX search.generation_publication_subject_coverage;
DROP INDEX semantic.public_filter_bootstrap_publication_capture;
ALTER TABLE semantic.public_filter_bootstrap
  DROP CONSTRAINT public_filter_bootstrap_publication_coverage_check,
  DROP COLUMN coverage_publication;
