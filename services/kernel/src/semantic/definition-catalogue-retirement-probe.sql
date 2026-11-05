WITH input AS MATERIALIZED (SELECT :root::text AS root)
SELECT
 EXISTS(SELECT 1 FROM semantic.definition_catalogue_consumer WHERE route=0 AND root_digest=(SELECT root FROM input) LIMIT 1) AS consumers,
 EXISTS(SELECT 1 FROM semantic.definition_catalogue_frontier WHERE route=0 AND consumer_root=(SELECT root FROM input) LIMIT 1) AS captures,
 EXISTS(SELECT 1 FROM semantic.definition_catalogue_original WHERE route=0 AND root_digest=(SELECT root FROM input) AND state<>'terminal' LIMIT 1) AS unsettled,
 EXISTS(SELECT 1 FROM semantic.definition_catalogue_position WHERE route=0 AND root_digest=(SELECT root FROM input) LIMIT 1) AS positions;
