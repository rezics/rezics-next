-- migrate:up
-- Native admission binds the initiator account and epoch; account identity does not share the Book storage route.
ALTER TABLE content.hosted_publication_activation
  DROP CONSTRAINT hosted_publication_activation_check3;

ALTER TABLE content.hosted_version_release_candidate
  DROP CONSTRAINT hosted_version_release_candidate_check1,
  ADD CONSTRAINT hosted_version_release_candidate_check1 CHECK (
    route = get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)
    AND route = get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)
    AND (generation_id IS NULL OR route = get_byte(uuid_send(generation_id),10)*256+get_byte(uuid_send(generation_id),11))
    AND route = get_byte(uuid_send(source_revision_id),10)*256+get_byte(uuid_send(source_revision_id),11)
    AND route = get_byte(uuid_send(expected_head_revision_id),10)*256+get_byte(uuid_send(expected_head_revision_id),11)
    AND (expected_publication_id IS NULL OR
      route = get_byte(uuid_send(expected_publication_id),10)*256+get_byte(uuid_send(expected_publication_id),11))
  );

-- migrate:down
ALTER TABLE content.hosted_publication_activation
  ADD CONSTRAINT hosted_publication_activation_check3 CHECK (
    route = get_byte(uuid_send(initiator_account_id),10)*256+get_byte(uuid_send(initiator_account_id),11)
  );

ALTER TABLE content.hosted_version_release_candidate
  DROP CONSTRAINT hosted_version_release_candidate_check1,
  ADD CONSTRAINT hosted_version_release_candidate_check1 CHECK (
    route = get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)
    AND route = get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)
    AND (generation_id IS NULL OR route = get_byte(uuid_send(generation_id),10)*256+get_byte(uuid_send(generation_id),11))
    AND route = get_byte(uuid_send(initiator_account_id),10)*256+get_byte(uuid_send(initiator_account_id),11)
    AND route = get_byte(uuid_send(source_revision_id),10)*256+get_byte(uuid_send(source_revision_id),11)
    AND route = get_byte(uuid_send(expected_head_revision_id),10)*256+get_byte(uuid_send(expected_head_revision_id),11)
    AND (expected_publication_id IS NULL OR
      route = get_byte(uuid_send(expected_publication_id),10)*256+get_byte(uuid_send(expected_publication_id),11))
  );
