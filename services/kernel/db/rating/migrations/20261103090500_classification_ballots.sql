-- migrate:up
CREATE TABLE rating.classification_ballot_actor (
  route integer NOT NULL,
  actor_id uuid NOT NULL,
  eligible boolean NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  tombstoned boolean NOT NULL,
  cleanup_pending boolean NOT NULL,
  source_epoch integer NOT NULL CHECK (source_epoch >= 0),
  source_position bigint NOT NULL CHECK (source_position >= 0),
  PRIMARY KEY (route, actor_id),
  CHECK (route = get_byte(uuid_send(actor_id), 10) * 256 + get_byte(uuid_send(actor_id), 11)),
  CHECK (NOT eligible OR NOT tombstoned)
);

CREATE TABLE rating.classification_ballot (
  route integer NOT NULL,
  actor_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  association_id uuid NOT NULL,
  binding_hash bytea NOT NULL CHECK (octet_length(binding_hash) = 32),
  assessment text CHECK (assessment IN ('support', 'oppose')),
  false_positive boolean NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  eligibility_generation bigint NOT NULL CHECK (eligibility_generation > 0),
  eligible boolean NOT NULL,
  PRIMARY KEY (route, actor_id, subject_id, association_id),
  CHECK (route = get_byte(uuid_send(actor_id), 10) * 256 + get_byte(uuid_send(actor_id), 11)),
  CHECK (get_byte(uuid_send(subject_id), 10) = get_byte(uuid_send(association_id), 10)
     AND get_byte(uuid_send(subject_id), 11) = get_byte(uuid_send(association_id), 11)),
  CHECK (assessment IS NOT NULL OR NOT false_positive)
);

CREATE INDEX classification_ballot_cleanup_idx
  ON rating.classification_ballot (route, actor_id, eligibility_generation, subject_id, association_id)
  WHERE assessment IS NOT NULL;

CREATE TABLE rating.classification_aggregate (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  association_id uuid NOT NULL,
  binding_hash bytea NOT NULL CHECK (octet_length(binding_hash) = 32),
  support_count integer NOT NULL CHECK (support_count >= 0),
  oppose_count integer NOT NULL CHECK (oppose_count >= 0),
  false_positive_count integer NOT NULL CHECK (false_positive_count >= 0),
  generation bigint NOT NULL CHECK (generation > 0),
  as_of timestamptz NOT NULL,
  PRIMARY KEY (route, subject_id, association_id, binding_hash),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (route = get_byte(uuid_send(association_id), 10) * 256 + get_byte(uuid_send(association_id), 11)),
  CHECK (false_positive_count <= support_count + oppose_count)
);

CREATE TABLE rating.classification_contribution (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  association_id uuid NOT NULL,
  binding_hash bytea NOT NULL CHECK (octet_length(binding_hash) = 32),
  actor_route integer NOT NULL,
  actor_id uuid NOT NULL,
  assessment text CHECK (assessment IN ('support', 'oppose')),
  false_positive boolean NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  eligibility_generation bigint NOT NULL CHECK (eligibility_generation > 0),
  eligible boolean NOT NULL,
  PRIMARY KEY (route, subject_id, association_id, actor_route, actor_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (route = get_byte(uuid_send(association_id), 10) * 256 + get_byte(uuid_send(association_id), 11)),
  CHECK (actor_route = get_byte(uuid_send(actor_id), 10) * 256 + get_byte(uuid_send(actor_id), 11)),
  CHECK (assessment IS NOT NULL OR NOT false_positive)
);

-- migrate:down
DROP TABLE rating.classification_contribution;
DROP TABLE rating.classification_aggregate;
DROP INDEX rating.classification_ballot_cleanup_idx;
DROP TABLE rating.classification_ballot;
DROP TABLE rating.classification_ballot_actor;
