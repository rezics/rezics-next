INSERT INTO search.identity_receiving_native_document(partition_no,physical_target,document_id)
VALUES ($1,$2,$3) ON CONFLICT DO NOTHING;
