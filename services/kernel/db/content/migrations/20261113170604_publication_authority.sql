-- migrate:up
-- Eligibility source, exact consent, and the earliest content-erasure fence
-- advance the authority generation in the same physical transaction as change.
CREATE TRIGGER board_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF visibility,security_revision,realm_id ON content.board
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER thread_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF visibility,security_revision,availability,board_id,first_post_id ON content.thread
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER post_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF visibility,security_revision,availability,author_erased,author_account_id,
  thread_id,head_revision_id,reply_to_post_id ON content.post
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER revision_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF availability,body,body_sha256,licence,subject_ids,board_id ON content.revision
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER revision_disclosure_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF revoked_at ON content.revision_disclosure
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER erasure_fence_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF closed_at ON content.erasure_fence
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER moderation_decision_publication_authority
AFTER INSERT OR UPDATE OR DELETE ON content.moderation_decision
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE INDEX hosted_publication_staging_candidate_target
  ON content.hosted_publication_staging_candidate
    (route,catalogue_id,stage_id,thread_id,post_id,target_revision_id,body_sha256,occurrence_id)
  WHERE kind='chapter';

-- The retained pass binds one exact candidate and its complete captured vector.
CREATE TABLE content.hosted_publication_activation (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  initiator_account_id uuid NOT NULL,
  owner_epoch bigint NOT NULL CHECK (owner_epoch >= 0),
  pass_id uuid NOT NULL,
  activation_revision_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  expected_head_revision_id uuid NOT NULL,
  expected_publication_id uuid,
  candidate_generation_id uuid NOT NULL,
  candidate_sequence bigint NOT NULL CHECK (candidate_sequence >= 0),
  candidate_preorder_root_id uuid,
  candidate_chapter_root_id uuid,
  candidate_placement_count bigint NOT NULL CHECK (candidate_placement_count >= 0),
  candidate_chapter_count bigint NOT NULL CHECK (candidate_chapter_count BETWEEN 0 AND candidate_placement_count),
  target_after_thread_id uuid,
  target_after_post_id uuid,
  target_after_revision_id uuid,
  target_after_sha256 bytea,
  target_checked_count bigint NOT NULL DEFAULT 0 CHECK (target_checked_count >= 0),
  target_total_count bigint NOT NULL CHECK (target_total_count >= 1),
  opening_thread_id uuid,
  opening_revision_id uuid,
  opening_sha256 bytea,
  opening_checked boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN ('checking','ready','restart','activated')),
  publication_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK (isfinite(updated_at)),
  completed_at timestamptz CHECK (completed_at IS NULL OR isfinite(completed_at)),
  PRIMARY KEY (route,catalogue_id,stage_id),
  UNIQUE (route,catalogue_id,pass_id),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_version_release_candidate(route,catalogue_id,stage_id),
  FOREIGN KEY (route,catalogue_id,source_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  FOREIGN KEY (route,catalogue_id,expected_head_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  FOREIGN KEY (route,catalogue_id,expected_publication_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  FOREIGN KEY (route,catalogue_id,publication_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  CHECK (route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)),
  CHECK (route=get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)),
  CHECK (route=get_byte(uuid_send(initiator_account_id),10)*256+get_byte(uuid_send(initiator_account_id),11)),
  CHECK (route=get_byte(uuid_send(pass_id),10)*256+get_byte(uuid_send(pass_id),11)),
  CHECK (route=get_byte(uuid_send(activation_revision_id),10)*256+get_byte(uuid_send(activation_revision_id),11)),
  CHECK (route=get_byte(uuid_send(source_revision_id),10)*256+get_byte(uuid_send(source_revision_id),11)),
  CHECK (route=get_byte(uuid_send(expected_head_revision_id),10)*256+get_byte(uuid_send(expected_head_revision_id),11)),
  CHECK (expected_head_revision_id=source_revision_id),
  CHECK (expected_publication_id IS NULL OR
    route=get_byte(uuid_send(expected_publication_id),10)*256+get_byte(uuid_send(expected_publication_id),11)),
  CHECK (route=get_byte(uuid_send(candidate_generation_id),10)*256+get_byte(uuid_send(candidate_generation_id),11)),
  CHECK (candidate_preorder_root_id IS NULL OR
    route=get_byte(uuid_send(candidate_preorder_root_id),10)*256+get_byte(uuid_send(candidate_preorder_root_id),11)),
  CHECK (candidate_chapter_root_id IS NULL OR
    route=get_byte(uuid_send(candidate_chapter_root_id),10)*256+get_byte(uuid_send(candidate_chapter_root_id),11)),
  CHECK ((target_after_thread_id IS NULL AND target_after_post_id IS NULL AND target_after_revision_id IS NULL
      AND target_after_sha256 IS NULL) OR
    (target_after_thread_id IS NOT NULL AND target_after_post_id IS NOT NULL AND target_after_revision_id IS NOT NULL
      AND octet_length(target_after_sha256)=32)),
  CHECK (opening_sha256 IS NULL OR octet_length(opening_sha256)=32),
  CHECK (publication_id IS NULL OR
    route=get_byte(uuid_send(publication_id),10)*256+get_byte(uuid_send(publication_id),11)),
  CHECK ((state='activated')=(publication_id IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE content.hosted_publication_activation_vector (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  pass_id uuid NOT NULL,
  home_no integer NOT NULL CHECK (home_no BETWEEN 0 AND 4095),
  generation uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  PRIMARY KEY (route,catalogue_id,stage_id,pass_id,home_no),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_publication_activation(route,catalogue_id,stage_id) ON DELETE CASCADE,
  FOREIGN KEY (home_no) REFERENCES core.publication_authority_epoch(home_no),
  CHECK (route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)),
  CHECK (route=get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)),
  CHECK (route=get_byte(uuid_send(pass_id),10)*256+get_byte(uuid_send(pass_id),11))
);

CREATE TABLE content.hosted_publication_activation_dependency (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  pass_id uuid NOT NULL,
  home_no integer NOT NULL CHECK (home_no BETWEEN 0 AND 4095),
  generation uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  observation_count bigint NOT NULL CHECK (observation_count > 0),
  PRIMARY KEY (route,catalogue_id,stage_id,pass_id,home_no),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_publication_activation(route,catalogue_id,stage_id) ON DELETE CASCADE,
  FOREIGN KEY (route,catalogue_id,stage_id,pass_id,home_no)
    REFERENCES content.hosted_publication_activation_vector(route,catalogue_id,stage_id,pass_id,home_no),
  CHECK (route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)),
  CHECK (route=get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)),
  CHECK (route=get_byte(uuid_send(pass_id),10)*256+get_byte(uuid_send(pass_id),11))
);

CREATE INDEX hosted_publication_activation_state_idx
  ON content.hosted_publication_activation(route,catalogue_id,state,stage_id);

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Hosted publication activation proofs are retained and forward-only' USING ERRCODE='23514';
END;
$$;
