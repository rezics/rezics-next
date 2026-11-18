SELECT p.partition_no AS partition,p.position::text,p.write_state AS "writeState",
       p.moved_to AS "movedTo",coalesce(s.visible,0)::text AS visible
FROM core.partition p LEFT JOIN semantic.partition_subjects s USING (partition_no)
WHERE p.partition_no = ANY(:partitions::integer[]);
