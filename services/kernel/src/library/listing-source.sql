SELECT collection.transaction_id AS "transactionId",
       CASE WHEN collection.state = 'active' AND collection.visibility = 'public' THEN
         (SELECT count(*)::integer FROM library.collection_member AS member
          WHERE member.route = collection.route AND member.collection_id = collection.collection_id
            AND member.subject_id = :subject_id)
       ELSE 0 END AS multiplicity
FROM library.collection
WHERE route = :route AND collection_id = :collection_id;
