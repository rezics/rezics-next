-- migrate:up
-- Consumer work belongs to the existing physical custody, not a second registry.
ALTER TABLE search.public_filter_registration ADD COLUMN consumer_work text, ADD COLUMN consumer_bootstrap text,
    ADD CONSTRAINT public_filter_registration_consumer_work_check CHECK (octet_length(consumer_work) <= 1048576);
ALTER TABLE search.public_filter_observation ADD COLUMN consumer_work text, ADD COLUMN consumer_bootstrap text,
    ADD CONSTRAINT public_filter_observation_consumer_work_check CHECK (octet_length(consumer_work) <= 1048576);
ALTER TABLE search.public_filter_execution ADD COLUMN consumer_repair text,
    ADD CONSTRAINT public_filter_execution_consumer_repair_check CHECK (octet_length(consumer_repair) <= 1048576),
    ADD COLUMN consumer_window text,
    ADD CONSTRAINT public_filter_execution_consumer_window_check CHECK (octet_length(consumer_window) <= 1048576);

CREATE UNIQUE INDEX public_filter_observation_bootstrap ON search.public_filter_observation(partition_no,consumer_bootstrap) WHERE consumer_bootstrap IS NOT NULL;
CREATE UNIQUE INDEX public_filter_registration_bootstrap ON search.public_filter_registration(partition_no,consumer_bootstrap) WHERE consumer_bootstrap IS NOT NULL;

-- migrate:down
DROP INDEX search.public_filter_registration_bootstrap;
DROP INDEX search.public_filter_observation_bootstrap;
ALTER TABLE search.public_filter_execution DROP COLUMN consumer_window, DROP COLUMN consumer_repair;
ALTER TABLE search.public_filter_observation DROP COLUMN consumer_work, DROP COLUMN consumer_bootstrap;
ALTER TABLE search.public_filter_registration DROP COLUMN consumer_work, DROP COLUMN consumer_bootstrap;
