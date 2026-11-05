INSERT INTO semantic.public_filter_projection_build
  (partition_no, route, subject_id, meaning_digest, meaning_type, build_id, generation, owner_epoch,
   source_position, privacy_position, terminal_id, subject_revision, security_revision, current_release)
VALUES
  (:partition_no::integer, :route::integer, :subject_id::uuid, :meaning_digest, :meaning_type, :build_id::uuid, 1,
   :owner_epoch::integer, :source_position::bigint, :privacy_position::bigint, :terminal_id::uuid,
   :subject_revision::integer, :security_revision::bigint, :current_release)
ON CONFLICT (partition_no, subject_id) DO UPDATE
SET build_id = EXCLUDED.build_id,
    generation = semantic.public_filter_projection_build.generation + 1,
    route = EXCLUDED.route,
    owner_epoch = EXCLUDED.owner_epoch,
    source_position = EXCLUDED.source_position,
    privacy_position = EXCLUDED.privacy_position,
    terminal_id = EXCLUDED.terminal_id,
    subject_revision = EXCLUDED.subject_revision,
    security_revision = EXCLUDED.security_revision,
    current_release = EXCLUDED.current_release
RETURNING build_id::text, generation::text, route;
