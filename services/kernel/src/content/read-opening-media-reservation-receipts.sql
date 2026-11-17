SELECT r.idempotency_key, r.request_digest, r.response->>'mediaId' AS media_id,
       b.client_id, b.requested_by
FROM core.receipt r
JOIN editorial.write_basis b ON (b.partition_no, b.transaction_id) = (r.partition_no, r.transaction_id)
  AND (b.principal_kind, b.principal_id, b.epoch, b.position) =
      (r.principal_kind, r.principal_id, r.epoch, r.position)
WHERE r.partition_no = :partition_no::integer AND r.principal_kind = 'account'
  AND r.principal_id = :uploader_id::uuid AND r.command_kind = 'content.media.reserve'
  AND r.idempotency_key = ANY(:receipt_keys::text[]) AND r.payload_state = 'present' AND r.position > 0;
