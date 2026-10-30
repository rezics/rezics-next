SELECT epoch, position::text AS position, write_state AS "writeState", moved_to AS "movedTo"
FROM core.partition WHERE partition_no=:partition_no FOR SHARE;
