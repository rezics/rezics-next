WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :receipt_id::uuid AS receipt_id,
         :transaction_id::uuid AS transaction_id, :tombstone::boolean AS tombstone,
         :kind::text AS kind, NULLIF(:prior_operator_id::text, '')::uuid AS prior_operator_id
), counter_time AS MATERIALIZED (
  SELECT set_config('rezics.operator_at', :at::text, true)
), changed AS (
  UPDATE access.account
  SET minimum_authn_epoch = minimum_authn_epoch + 1, authn_fenced = true, fence_receipt_id = i.receipt_id,
      transaction_id = i.transaction_id,
      state = CASE WHEN i.tombstone THEN 'deleted' ELSE state END,
      handle = CASE WHEN i.tombstone THEN NULL ELSE handle END,
      display_name = CASE WHEN i.tombstone THEN NULL ELSE display_name END,
      avatar_url = CASE WHEN i.tombstone THEN NULL ELSE avatar_url END,
      avatar = NULL,
      public_views = '{"posts":false,"reviews":false,"collections":false,"realms":false}'::jsonb,
      speakers_listed = false,
      biography = NULL,
      links = '[]'::jsonb,
      operator_account_id = CASE WHEN i.tombstone THEN NULL ELSE operator_account_id END,
      controller_id = CASE WHEN i.tombstone THEN NULL ELSE controller_id END,
      birth_date = CASE WHEN i.tombstone THEN NULL ELSE birth_date END,
      content_preferences = CASE WHEN i.tombstone THEN '{}'::jsonb ELSE content_preferences END,
      suspension_reason = CASE WHEN i.tombstone THEN NULL ELSE suspension_reason END,
      registration_id = CASE WHEN i.tombstone THEN NULL ELSE registration_id END,
      registration_expires_at = CASE WHEN i.tombstone THEN NULL ELSE registration_expires_at END
  FROM input i CROSS JOIN counter_time
  WHERE access.account.route = i.route AND access.account.account_id = i.account_id AND state <> 'deleted'
  RETURNING minimum_authn_epoch
), erased_preferences AS (
  DELETE FROM access.account_preferences p
  USING input i, changed
  WHERE i.tombstone AND p.route = i.route AND p.account_id = i.account_id
)
INSERT INTO access.lifecycle_fence_receipt
  (route, account_id, receipt_id, minimum_authn_epoch, kind, prior_operator_account_id, transaction_id)
SELECT i.route, i.account_id, i.receipt_id, minimum_authn_epoch, i.kind, i.prior_operator_id, i.transaction_id FROM changed CROSS JOIN input i
RETURNING minimum_authn_epoch::text AS "minimumAuthnEpoch";
