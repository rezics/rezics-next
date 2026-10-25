DELETE FROM access.resource_grant
WHERE route = :route AND resource_id = :resource_id AND subject_id = :subject_id AND subject_role = :subject_role
  AND action = ANY(:actions::text[]) AND valid = :valid::tstzrange
RETURNING action;
