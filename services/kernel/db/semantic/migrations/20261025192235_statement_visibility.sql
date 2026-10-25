-- migrate:up
ALTER TABLE semantic.moderation
  ADD COLUMN candidate_id uuid;

ALTER TABLE semantic.moderation
  ADD CONSTRAINT moderation_route_subject_id_candidate_id_fkey
  FOREIGN KEY (route, subject_id, candidate_id)
  REFERENCES semantic.candidate (route, subject_id, candidate_id);

CREATE TABLE semantic.hidden_candidate (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  visibility text NOT NULL,
  security_revision bigint NOT NULL,
  PRIMARY KEY (route, subject_id, candidate_id),
  CONSTRAINT hidden_candidate_visibility_check CHECK (visibility IN ('hidden', 'taken_down')),
  CONSTRAINT hidden_candidate_security_revision_check CHECK (security_revision > 0),
  CONSTRAINT hidden_candidate_route_check CHECK (route BETWEEN 0 AND 65535),
  CONSTRAINT hidden_candidate_subject_route_check CHECK (
    route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)
  ),
  CONSTRAINT hidden_candidate_candidate_route_check CHECK (
    route = get_byte(uuid_send(candidate_id), 10) * 256 + get_byte(uuid_send(candidate_id), 11)
  ),
  CONSTRAINT hidden_candidate_route_subject_id_candidate_id_fkey
    FOREIGN KEY (route, subject_id, candidate_id)
    REFERENCES semantic.candidate (route, subject_id, candidate_id)
);

ALTER TABLE semantic.inbound_link
  ADD COLUMN source_security_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE semantic.inbound_link
  ADD CONSTRAINT inbound_link_source_security_revision_check CHECK (source_security_revision >= 0);

-- migrate:down
ALTER TABLE semantic.inbound_link DROP CONSTRAINT inbound_link_source_security_revision_check;
ALTER TABLE semantic.inbound_link DROP COLUMN source_security_revision;
DROP TABLE semantic.hidden_candidate;
ALTER TABLE semantic.moderation DROP CONSTRAINT moderation_route_subject_id_candidate_id_fkey;
ALTER TABLE semantic.moderation DROP COLUMN candidate_id;
