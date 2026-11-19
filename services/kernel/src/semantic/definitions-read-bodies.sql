SELECT digest, CASE WHEN digest = ANY(:missing::text[]) THEN body END AS body
FROM semantic.definition_release
WHERE route = 0 AND digest = ANY(:digests::text[]);
