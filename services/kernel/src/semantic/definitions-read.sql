SELECT body
FROM semantic.definition_release
WHERE route = :route::integer AND digest = :digest::text;
