SELECT pg_try_advisory_lock(hashtextextended('search-rebuild:' || :alias, 0)) AS locked;
