-- Authoritative source metadata for one exact private opening. Metadata never
-- authorizes consent. Bodies are not selected; stored digest is compared.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :thread_id::uuid AS thread_id, :post_id::uuid AS post_id,
         :revision_id::uuid AS revision_id, decode(:sha256::text, 'hex') AS body_sha256
)
SELECT t.thread_id, p.post_id, r.revision_id, encode(r.body_sha256, 'hex') AS sha256, r.licence,
       p.author_account_id AS creator_account_id, p.visibility AS post_visibility,
       t.visibility AS thread_visibility, p.availability AS post_availability,
       t.availability AS thread_availability, r.availability AS revision_availability,
       p.recorded_transaction_id AS source_post_transaction_id,
       t.recorded_transaction_id AS source_thread_transaction_id,
       p.security_revision::text AS source_post_security_revision,
       t.security_revision::text AS source_thread_security_revision,
       p.author_erased, p.reply_to_post_id, t.first_post_id
FROM input i
JOIN content.thread t ON t.route = i.route AND t.thread_id = i.thread_id
JOIN content.post p ON p.route = i.route AND p.thread_id = t.thread_id AND p.post_id = i.post_id
JOIN content.revision r
  ON r.route = i.route AND r.thread_id = t.thread_id AND r.post_id = p.post_id
 AND r.revision_id = i.revision_id AND r.body_sha256 = i.body_sha256
JOIN editorial.write_basis w
  ON w.partition_no = :partition_no::integer AND w.transaction_id = r.recorded_transaction_id
 AND w.principal_kind = 'account' AND w.principal_id = p.author_account_id
WHERE p.availability = 'available' AND t.availability = 'available' AND r.availability = 'available'
  AND p.visibility = 'draft' AND t.visibility = 'draft'
  AND NOT p.author_erased AND p.reply_to_post_id IS NULL AND t.first_post_id = p.post_id
  AND r.body IS NOT NULL AND octet_length(r.body_sha256) = 32
LIMIT 1;
