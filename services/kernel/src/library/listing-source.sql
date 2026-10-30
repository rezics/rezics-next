WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route)
SELECT collection.transaction_id AS "transactionId",
       CASE WHEN collection.state = 'active' AND collection.visibility = 'public' THEN
         (SELECT count(*)::integer FROM library.collection_member AS member
          WHERE member.route = input.route AND member.collection_id = collection.collection_id
            AND member.subject_id = :subject_id AND member.deletion_id IS NULL)
       ELSE 0 END AS multiplicity
FROM library.collection CROSS JOIN input
WHERE collection.route = input.route AND collection_id = :collection_id;
