WITH input AS (SELECT :time::timestamptz AS time)
INSERT INTO library.collection
  (route, collection_id, curator_account_id, title, description, visibility, presentation_kind, cover_media_id,
   state, revision, member_count, order_epoch, created_at, updated_at, transaction_id, membership_kind,
   source_generation, rule_filter, rule_sort, rule_source, rule_release_digest, rule_revision)
SELECT :route, :collection_id, :curator_account_id, :title, :description::nullable(text), :visibility,
        :presentation_kind::nullable(text), :cover_media_id::nullable(uuid),
        'active', 1, 0, 0, input.time, input.time, :transaction_id, 'dynamic',
        1, :filter::text::jsonb, :sort, :source, :release_digest, 1
FROM input;
