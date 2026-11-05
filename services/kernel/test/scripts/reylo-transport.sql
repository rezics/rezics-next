SELECT :body::jsonb AS body, (ARRAY['first', 'second'])[(:index::int)] AS tag;
