INSERT INTO rating.identity_repair_receipt
  (route, voter_id, page_id, work_id, generation, digest, transaction_id, checkpoint, terminal, mode, obligation_id, mapping_digest)
VALUES ($1::integer, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text, $7::uuid, $8::jsonb, $9::boolean, $10::text, $11::text, $12::text);
