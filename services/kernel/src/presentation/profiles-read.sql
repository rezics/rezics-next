SELECT body
FROM presentation.profile
WHERE route = :route::integer AND digest = :digest::text;
