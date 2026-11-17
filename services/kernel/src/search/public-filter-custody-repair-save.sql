WITH input AS (
  SELECT :partition_no::integer AS partition_no,:observation::text AS observation,
    :execution::text AS execution,NULLIF(:previous::text,'') AS previous,
    :empty_page_ordinal::integer AS empty_page_ordinal,NULLIF(:empty_page_intent::text,'') AS empty_page_intent
), locked AS (
  SELECT o.observation FROM search.public_filter_observation o
  JOIN input i ON (o.partition_no,o.observation)=(i.partition_no,i.observation)
  WHERE o.state='open' AND o.consumer_work=:old_work::text FOR UPDATE OF o
), ready AS (
  SELECT e.id FROM search.public_filter_execution e
  JOIN input i ON (e.partition_no,e.observation)=(i.partition_no,i.observation)
  JOIN locked l ON l.observation=i.observation
  WHERE i.empty_page_intent IS NOT NULL AND e.id=i.execution
    AND e.repair_settlement IS NOT DISTINCT FROM i.previous
  FOR NO KEY UPDATE OF e
), inserted AS (
  INSERT INTO search.public_filter_repair_page
    (partition_no,observation,execution,ordinal,has_repairs,intent)
  SELECT i.partition_no,i.observation,e.id,i.empty_page_ordinal,false,i.empty_page_intent
  FROM ready e CROSS JOIN input i
  ON CONFLICT DO NOTHING RETURNING ordinal
), advanced AS (
  UPDATE search.public_filter_execution e SET repair_settlement=:settlement::text
  FROM input i
  WHERE (e.partition_no,e.observation)=(i.partition_no,i.observation) AND e.id=i.execution
    AND e.repair_settlement IS NOT DISTINCT FROM i.previous
    AND EXISTS (SELECT 1 FROM locked)
    AND (i.empty_page_intent IS NULL OR EXISTS (SELECT 1 FROM inserted))
  RETURNING e.id
) UPDATE search.public_filter_observation o SET consumer_work=:next_work::text
FROM input i WHERE (o.partition_no,o.observation)=(i.partition_no,i.observation)
  AND EXISTS (SELECT 1 FROM advanced) RETURNING o.observation;
