-- migrate:up
-- The manifest IS the native plan. No receiving outcome or count establishes its seal.
CREATE TABLE library.identity_scope_plan (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  plan_key text NOT NULL CHECK (octet_length(plan_key)=64),
  account_id uuid NOT NULL,
  source_identity jsonb NOT NULL CHECK (octet_length(source_identity::text)<=2048),
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL CHECK (job_epoch>0),
  scope text COLLATE "C" NOT NULL CHECK (octet_length(scope) BETWEEN 1 AND 256),
  generation uuid NOT NULL,
  capture_id uuid NOT NULL,
  capture_frontier jsonb NOT NULL CHECK (octet_length(capture_frontier::text)<=2048),
  collection_fence bigint NOT NULL,
  account_fence bigint NOT NULL,
  job_transaction_id uuid NOT NULL,
  scope_digest text NOT NULL,
  job_writer_fence jsonb NOT NULL CHECK(octet_length(job_writer_fence::text)<=2048),
  phase text NOT NULL CHECK(phase IN ('old-references','old-ready','old-working','raw')),
  driver text NOT NULL CHECK (driver IN ('member','entry','label','session','copy','output','done')),
  after_subject uuid,
  after_fact uuid,
  version bigint NOT NULL DEFAULT 0 CHECK (version>=0),
  state text NOT NULL DEFAULT 'building' CHECK (state IN ('building','sealed','invalidated')),
  old_head uuid,
  old_state jsonb,
  frontier jsonb NOT NULL CHECK (octet_length(frontier::text)<=2048),
  seal_transaction_id uuid,
  PRIMARY KEY(route,collection_id,plan_key),
  FOREIGN KEY(route,capture_id) REFERENCES library.native_source_capture(route,capture_id),
  FOREIGN KEY(route,collection_id,generation) REFERENCES library.canonical_source_generation(route,collection_id,generation),
  FOREIGN KEY(route,collection_id,old_head) REFERENCES library.canonical_source_generation(route,collection_id,generation),
  CHECK ((after_subject IS NULL)=(after_fact IS NULL)),
  CHECK (state<>'sealed' OR seal_transaction_id IS NOT NULL),
  CHECK (state<>'sealed' OR (driver='done' AND phase='raw'))
);
CREATE UNIQUE INDEX identity_scope_plan_generation ON library.identity_scope_plan(route,collection_id,generation);
CREATE INDEX identity_scope_plan_owner ON library.identity_scope_plan(route,account_id,collection_id,plan_key);
CREATE INDEX identity_scope_plan_capture ON library.identity_scope_plan(route,capture_id,collection_id,plan_key);
CREATE INDEX identity_scope_plan_pending ON library.identity_scope_plan(route,job_id,job_epoch,collection_id,plan_key) WHERE state='building';
CREATE TABLE library.identity_scope_effect (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  plan_key text NOT NULL,
  effect_key text COLLATE "C" NOT NULL CHECK(octet_length(effect_key) BETWEEN 1 AND 256),
  disposition text COLLATE "C" NOT NULL CHECK(disposition IN ('OLD','NEW','first-apply','handoff')),
  original uuid NOT NULL,
  -- Full native operation key retained and compared on digest collision. No user fact payload.
  operation jsonb NOT NULL CHECK(octet_length(operation::text)<=4096),
  PRIMARY KEY(route,collection_id,plan_key,effect_key,disposition),
  FOREIGN KEY(route,collection_id,plan_key) REFERENCES library.identity_scope_plan(route,collection_id,plan_key)
);
-- Completion lookup cannot walk unfinished or old captures behind the current native writer fence.
CREATE INDEX native_source_capture_identity ON library.native_source_capture
 (route,collection_id,account_id,incarnation,generation,scope,owner_epoch,receiving_epoch,effect_key,collection_fence,account_fence,capture_id);

CREATE TABLE library.identity_scope_seal (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  plan_key text NOT NULL,
  generation uuid NOT NULL,
  version bigint NOT NULL,
  frontier jsonb NOT NULL CHECK(octet_length(frontier::text)<=2048),
  capture_frontier jsonb NOT NULL CHECK(octet_length(capture_frontier::text)<=2048),
  transaction_id uuid NOT NULL,
  PRIMARY KEY(route,collection_id,plan_key,version),
  FOREIGN KEY(route,collection_id,plan_key) REFERENCES library.identity_scope_plan(route,collection_id,plan_key)
);
CREATE FUNCTION library.guard_identity_scope_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Native identity Source evidence remains retained until real control handoff';
END; $$;
CREATE TRIGGER identity_scope_effect_immutable BEFORE UPDATE OR DELETE ON library.identity_scope_effect
  FOR EACH ROW EXECUTE FUNCTION library.guard_identity_scope_evidence();
CREATE TRIGGER identity_scope_seal_immutable BEFORE UPDATE OR DELETE ON library.identity_scope_seal
  FOR EACH ROW EXECUTE FUNCTION library.guard_identity_scope_evidence();

CREATE INDEX canonical_source_identity_raw ON library.canonical_source_reference
 (route,collection_id,generation,driver,stored_subject_id,fact_id);
CREATE INDEX canonical_source_identity_old_fact ON library.canonical_source_fact
 (route,collection_id,generation,basis_digest,driver,stored_subject_id,fact_id);

-- migrate:down
