-- Recheck incarnation and availability without bodies. Issue still requires draft
-- through the source observer; revoke keeps working after a later publication.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :thread_id::uuid AS thread_id, :post_id::uuid AS post_id,
         :revision_id::uuid AS revision_id, decode(:sha256::text, 'hex') AS body_sha256,
         :source_post_transaction_id::uuid AS source_post_transaction_id,
         :source_thread_transaction_id::uuid AS source_thread_transaction_id
)
SELECT p.post_id
FROM input i
JOIN content.thread t ON t.route = i.route AND t.thread_id = i.thread_id
JOIN content.post p ON p.route = i.route AND p.thread_id = t.thread_id AND p.post_id = i.post_id
JOIN content.revision r
  ON r.route = i.route AND r.thread_id = t.thread_id AND r.post_id = p.post_id
 AND r.revision_id = i.revision_id AND r.body_sha256 = i.body_sha256
WHERE p.availability = 'available' AND t.availability = 'available' AND r.availability = 'available'
  AND NOT p.author_erased AND p.reply_to_post_id IS NULL AND t.first_post_id = p.post_id
  AND p.recorded_transaction_id = i.source_post_transaction_id
  AND t.recorded_transaction_id = i.source_thread_transaction_id
  AND r.body IS NOT NULL AND octet_length(r.body_sha256) = 32
LIMIT 1;
