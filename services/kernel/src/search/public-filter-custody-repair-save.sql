WITH input AS (
  SELECT :partition_no::integer AS partition_no,:observation::text AS observation
), locked AS (
  SELECT o.observation FROM search.public_filter_observation o
  JOIN input i ON (o.partition_no,o.observation)=(i.partition_no,i.observation)
  WHERE o.state='open' AND o.consumer_work=:old_work::text FOR UPDATE OF o
), advanced AS (
  UPDATE search.public_filter_execution e SET repair_settlement=:settlement::text
  FROM input i
  WHERE (e.partition_no,e.observation)=(i.partition_no,i.observation) AND e.id=:execution::text
    AND e.repair_settlement IS NOT DISTINCT FROM NULLIF(:previous::text,'')
    AND EXISTS (SELECT 1 FROM locked) RETURNING e.id
) UPDATE search.public_filter_observation o SET consumer_work=:next_work::text
FROM input i WHERE (o.partition_no,o.observation)=(i.partition_no,i.observation)
  AND EXISTS (SELECT 1 FROM advanced) RETURNING o.observation;
