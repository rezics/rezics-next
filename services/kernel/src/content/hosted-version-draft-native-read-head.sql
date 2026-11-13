SELECT head_revision_id
FROM content.hosted_catalogue
WHERE route = $1 AND catalogue_id = $2
