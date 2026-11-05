INSERT INTO access.erasure (route, account_id, version, at)
VALUES (:route::integer, :account_id::uuid, :version::integer, :at::timestamptz);
