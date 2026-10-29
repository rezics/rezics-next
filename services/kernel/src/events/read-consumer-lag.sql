SELECT oldest_pending_at, observed_at
FROM core.consumer_lag
WHERE consumer = :consumer;
