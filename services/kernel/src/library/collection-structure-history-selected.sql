SELECT history.change_no::text AS "changeNo",
       history.recorded_at::text AS "recordedAt",
       history.change_kind AS "changeKind",
       history.member_id::text AS "memberId",
       history.member_revision::text AS "memberRevision",
       history.before_state AS "beforeState",
       history.after_state AS "afterState"
  FROM library.collection_structure_history AS history
 WHERE history.route = :route::integer AND history.collection_id = :collection_id::uuid
   AND history.change_no = ANY(:change_nos::bigint[])
 ORDER BY history.change_no DESC;
