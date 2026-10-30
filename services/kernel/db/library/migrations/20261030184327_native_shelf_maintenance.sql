-- migrate:up
CREATE TABLE library.shelf_maintenance (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  initialized boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'open' CHECK (mode IN ('open','rebuilding','purging','purged')),
  ready boolean NOT NULL DEFAULT false,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  active_generation uuid,
  run_id uuid,
  PRIMARY KEY (route,account_id),
  CHECK (route=get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)),
  CHECK (NOT ready OR active_generation IS NOT NULL)
);
CREATE TABLE library.shelf_maintenance_run (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  run_id uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  segment integer NOT NULL DEFAULT 0 CHECK (segment >= 0),
  kind text NOT NULL CHECK (kind IN ('backfill','counters','purge')),
  phase text NOT NULL,
  cursor jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cursor)='array' AND jsonb_array_length(cursor)<=8 AND octet_length(cursor::text)<=2048),
  build_generation uuid,
  enqueue_pending boolean NOT NULL DEFAULT true,
  enqueue_attempt bigint NOT NULL DEFAULT 0 CHECK (enqueue_attempt >= 0),
  cancelled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,account_id,run_id),
  CHECK (route=get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))
);
CREATE INDEX shelf_maintenance_runnable ON library.shelf_maintenance_run(route,account_id,run_id)
  WHERE NOT cancelled AND phase<>'complete';
CREATE TABLE library.shelf_maintenance_step (
  route integer NOT NULL, account_id uuid NOT NULL, run_id uuid NOT NULL,
  epoch bigint NOT NULL, sequence bigint NOT NULL,
  segment integer NOT NULL, phase text NOT NULL, cursor jsonb NOT NULL,
  build_generation uuid, input_identity jsonb CHECK (octet_length(input_identity::text)<=2048),
  PRIMARY KEY(route,account_id,run_id,epoch,sequence),
  CHECK (jsonb_typeof(cursor)='array' AND jsonb_array_length(cursor)<=8 AND octet_length(cursor::text)<=2048)
);
CREATE INDEX shelf_maintenance_step_evidence ON library.shelf_maintenance_step(route,account_id,run_id,epoch,sequence)
 WHERE input_identity IS NOT NULL OR cursor<>'[]'::jsonb;
CREATE TABLE library.shelf_maintenance_session (
  route integer NOT NULL, account_id uuid NOT NULL, run_id uuid NOT NULL,
  session_id uuid NOT NULL, last_changed_at timestamptz,
  PRIMARY KEY(route,account_id,run_id,session_id)
);
CREATE TABLE library.shelf_maintenance_head (
  route integer NOT NULL, account_id uuid NOT NULL, run_id uuid NOT NULL,
  subject_id uuid NOT NULL, last_changed_at timestamptz, last_completed_at timestamptz,
  PRIMARY KEY(route,account_id,run_id,subject_id)
);
CREATE TABLE library.shelf_maintenance_source (
  route integer NOT NULL, account_id uuid NOT NULL, run_id uuid NOT NULL,
  subject_id uuid NOT NULL, incarnation_id uuid NOT NULL, transaction_id uuid NOT NULL,
  source_id uuid NOT NULL, source_partition integer NOT NULL, source_epoch integer NOT NULL,
  source_position bigint NOT NULL, identity jsonb NOT NULL, origin_identity jsonb NOT NULL,
  reservation_id uuid, type_id uuid,
  PRIMARY KEY(route,account_id,run_id,subject_id)
);
ALTER TABLE library.shelf_count ADD COLUMN generation_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE library.shelf_count DROP CONSTRAINT shelf_count_pkey;
ALTER TABLE library.shelf_count ADD PRIMARY KEY(route,account_id,generation_id,bucket,type_id);
DROP INDEX library.shelf_count_types;
CREATE INDEX shelf_count_types ON library.shelf_count(route,account_id,generation_id,type_id)
  WHERE bucket='all' AND type_id<>'00000000-0000-0000-0000-000000000000' AND n>0;
ALTER TABLE library.shelf_type_reservation ADD COLUMN maintenance_run_id uuid;
CREATE INDEX shelf_type_reservation_generation ON library.shelf_type_reservation(route,account_id,generation_id,reservation_id);

-- migrate:down
-- Forward only: terminal fences and complete generations must survive rollback.
