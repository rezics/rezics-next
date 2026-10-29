UPDATE library.copy
SET status = :status, location = :location::nullable(text), source = :source::nullable(text),
    acquired_on = :acquired_on::nullable(date), disposed_on = :disposed_on::nullable(date),
    note = :note::nullable(text), revision = revision + 1, updated_at = :time, transaction_id = :transaction_id,
    kind = COALESCE(:kind::nullable(text), kind),
    library_profile_pin = COALESCE(:library_profile_pin::nullable(jsonb), library_profile_pin)
WHERE route = :route AND copy_id = :copy_id AND revision = :revision
RETURNING route, copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", status, location, source,
          acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
          created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId";
