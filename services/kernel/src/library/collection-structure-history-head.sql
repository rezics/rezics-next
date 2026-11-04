SELECT head.next_change_no::text AS "nextChangeNo",
       head.unknown_before_tracking AS "unknownBeforeTracking",
       head.has_pruned_gaps AS "hasPrunedGaps",
       (SELECT count(*)::integer
          FROM library.collection_structure_history AS history
         WHERE history.route = head.route AND history.collection_id = head.collection_id) AS "retainedCount",
       (SELECT min(history.change_no)::text
          FROM library.collection_structure_history AS history
         WHERE history.route = head.route AND history.collection_id = head.collection_id) AS "firstRetainedChangeNo"
  FROM library.collection_structure_history_head AS head
 WHERE head.route = :route::integer AND head.collection_id = :collection_id::uuid;
