SELECT pg_advisory_unlock(hashtextextended('search-rebuild:' || :alias, 0)) AS unlocked;
