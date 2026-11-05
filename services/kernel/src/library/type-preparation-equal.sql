WITH native_input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id, :full_type::text AS full_type)
SELECT (
  EXISTS (SELECT FROM library.shelf_type_reservation AS r
    WHERE r.route = (SELECT route FROM native_input) AND r.account_id = (SELECT account_id FROM native_input) AND r.reservation_id = :reservation_id::nullable(uuid)
      AND r.full_type COLLATE "C" = (SELECT full_type FROM native_input) COLLATE "C")
  OR EXISTS (SELECT FROM library.shelf_type_value AS v
    WHERE v.route = (SELECT route FROM native_input) AND v.account_id = (SELECT account_id FROM native_input) AND v.type_id = :type_id::nullable(uuid)
      AND v.full_type COLLATE "C" = (SELECT full_type FROM native_input) COLLATE "C")
) AS equal;
