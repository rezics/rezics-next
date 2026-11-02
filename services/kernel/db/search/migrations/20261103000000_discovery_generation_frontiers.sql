-- migrate:up
-- Live inventory is independent of retired rebuild history; certified work needs the same prefix/generation seek.
CREATE INDEX discovery_generation_live
ON search.discovery_generation (partition_no, prefix, generation)
WHERE state <> 'retired';
CREATE INDEX discovery_population_uncertified
ON search.discovery_population (prefix, generation, partition_no, owner)
WHERE NOT certified;

-- migrate:down
DROP INDEX discovery_population_uncertified;
DROP INDEX discovery_generation_live;
