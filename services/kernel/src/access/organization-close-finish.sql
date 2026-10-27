UPDATE access.organization_close
SET step = step + 1, complete = :complete
WHERE route = :route AND organization_id = :organization_id AND step = :step;
