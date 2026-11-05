WITH input AS (
  SELECT :time::timestamptz AS time, :library_profile_pin::nullable(jsonb) AS pin
)
INSERT INTO library.copy
  (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,
   created_at, updated_at, transaction_id, kind, library_profile_pin, kind_profile_pin, status_profile_pin,
   media_condition, packaging_condition)
SELECT :route, :copy_id, :account_id, :subject_id, :status, :location::nullable(text), :source::nullable(text),
       :acquired_on::nullable(date), :disposed_on::nullable(date), :note::nullable(text), 1, input.time, input.time,
       :transaction_id, :kind::nullable(text), input.pin, input.pin, input.pin,
       :media_condition::nullable(jsonb), :packaging_condition::nullable(jsonb)
FROM input
RETURNING route, copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status, location, source,
          acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
          created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId",
          media_condition AS "mediaCondition", packaging_condition AS "packagingCondition";
