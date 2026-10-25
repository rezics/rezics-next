WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT listing.subject_id::text AS "subjectId",
       listing.public_collection_count AS "publicCollectionCount"
FROM unnest(:subject_ids::uuid[]) AS ids(subject_id)
JOIN LATERAL (
  SELECT subject_id, public_collection_count FROM library.subject_listing
  CROSS JOIN input
  WHERE route = get_byte(uuid_send(ids.subject_id), 10) * 256 + get_byte(uuid_send(ids.subject_id), 11)
    AND subject_id = ids.subject_id
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  LIMIT 1
) AS listing ON true;
