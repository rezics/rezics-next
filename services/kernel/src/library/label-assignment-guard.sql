-- UUID casts canonicalize spelling before hashing the domain-separated tuple.
WITH guarded AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended(
  jsonb_build_array('library.label_assignment.admission.v1', :route::integer,
                   :account_id::uuid, :subject_id::uuid)::text, 0))
)
SELECT :label_id::uuid AS "labelId" FROM guarded;
