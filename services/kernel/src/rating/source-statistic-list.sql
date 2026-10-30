SELECT source, source_alias AS "sourceAlias", source_record_id AS "sourceRecordId",
       scale_min AS "scaleMin", scale_max AS "scaleMax", mean::text,
       count, as_of::text AS "asOf", licence, attribution
FROM rating.source_statistic
WHERE route = :route::integer AND subject_id = :subject_id::uuid
ORDER BY source;
