INSERT INTO access.organization_close(route, organization_id, receipt_id, handle, handle_key)
VALUES (:route, :organization_id, :receipt_id, :handle::nullable(text), :handle_key);
