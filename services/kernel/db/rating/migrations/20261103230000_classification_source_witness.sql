-- migrate:up
CREATE TABLE rating.classification_aggregate_source (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  association_id uuid NOT NULL,
  binding_hash bytea NOT NULL CHECK (octet_length(binding_hash) = 32),
  source_partition integer NOT NULL CHECK (source_partition BETWEEN 0 AND 4095),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  PRIMARY KEY (route, subject_id, association_id, binding_hash, source_partition),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (route = get_byte(uuid_send(association_id), 10) * 256 + get_byte(uuid_send(association_id), 11))
);

-- Existing contributions must acquire the same witness before they can be published.
INSERT INTO rating.classification_aggregate_source
  (route, subject_id, association_id, binding_hash, source_partition, source_epoch, source_position)
SELECT DISTINCT ON (route, subject_id, association_id, binding_hash, actor_route / 16)
  route, subject_id, association_id, binding_hash, actor_route / 16, source_epoch, source_position
FROM rating.classification_contribution
ORDER BY route, subject_id, association_id, binding_hash, actor_route / 16,
         source_epoch DESC, source_position DESC;

-- migrate:down
DROP TABLE rating.classification_aggregate_source;
