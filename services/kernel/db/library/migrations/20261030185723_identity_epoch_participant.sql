-- migrate:up
-- Source receiving locators and structural scopes only. No copied original facts or permission authority.
CREATE TABLE library.identity_epoch_participant_work (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL CHECK (job_epoch > 0),
  effect_key text NOT NULL CHECK (octet_length(effect_key) BETWEEN 1 AND 256),
  original uuid NOT NULL,
  owner_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('member','entry','label','session','copy','output')),
  receiving_partition integer NOT NULL CHECK (receiving_partition BETWEEN 0 AND 4095),
  receiving_epoch integer NOT NULL CHECK (receiving_epoch > 0),
  receiving_position bigint NOT NULL CHECK (receiving_position > 0),
  receiving_transaction_id uuid NOT NULL,
  custodied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (partition_no,job_id,job_epoch,effect_key),
  CHECK (partition_no = ((get_byte(uuid_send(owner_id),10)*256+get_byte(uuid_send(owner_id),11)) >> 4)),
  CHECK (receiving_partition = partition_no)
);
CREATE INDEX identity_epoch_participant_pending
  ON library.identity_epoch_participant_work(partition_no,job_id,job_epoch,effect_key) WHERE NOT custodied;
CREATE INDEX identity_epoch_participant_owner
  ON library.identity_epoch_participant_work(partition_no,owner_id,job_id,job_epoch,effect_key);

CREATE TABLE library.owner_identity_scope (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  original uuid NOT NULL,
  source_id uuid NOT NULL,
  incarnation text NOT NULL CHECK (octet_length(incarnation) BETWEEN 1 AND 128),
  role text NOT NULL CHECK (role IN ('member','entry','label','session','copy','output')),
  owner_id uuid NOT NULL,
  source_route integer NOT NULL CHECK (source_route BETWEEN 0 AND 65535),
  PRIMARY KEY (partition_no,original,source_id,incarnation,role),
  CHECK (source_route = get_byte(uuid_send(source_id),10)*256+get_byte(uuid_send(source_id),11)),
  CHECK (partition_no = source_route >> 4),
  CHECK (partition_no = ((get_byte(uuid_send(owner_id),10)*256+get_byte(uuid_send(owner_id),11)) >> 4))
);
CREATE INDEX owner_identity_scope_owner
  ON library.owner_identity_scope(partition_no,owner_id,original,source_id,incarnation,role);

-- Detached generations remain retained until their exact Source/receiving/control obligations close.
-- A timeout, local exhaustion or an account-home probe is not disposition authority.
CREATE TABLE library.identity_epoch_source_basis (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL CHECK (job_epoch > 0),
  effect_key text NOT NULL CHECK (octet_length(effect_key) BETWEEN 1 AND 256),
  source_route integer NOT NULL CHECK (source_route BETWEEN 0 AND 65535),
  source_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  ready_generation uuid,
  ready_basis text CHECK (octet_length(ready_basis) BETWEEN 1 AND 256),
  working_generation uuid,
  working_basis text CHECK (octet_length(working_basis) BETWEEN 1 AND 256),
  PRIMARY KEY (partition_no,job_id,job_epoch,effect_key),
  CHECK ((ready_generation IS NULL) = (ready_basis IS NULL)),
  CHECK ((working_generation IS NULL) = (working_basis IS NULL)),
  CHECK (source_route = get_byte(uuid_send(source_id),10)*256+get_byte(uuid_send(source_id),11)),
  CHECK (partition_no = source_route >> 4),
  CHECK (partition_no = ((get_byte(uuid_send(owner_id),10)*256+get_byte(uuid_send(owner_id),11)) >> 4))
);
CREATE INDEX identity_epoch_source_basis_owner
  ON library.identity_epoch_source_basis(partition_no,owner_id,job_id,job_epoch,effect_key);

-- migrate:down
DROP TABLE library.identity_epoch_source_basis;
DROP TABLE library.owner_identity_scope;
DROP TABLE library.identity_epoch_participant_work;
