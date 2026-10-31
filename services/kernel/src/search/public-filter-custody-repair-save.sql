WITH locked AS (
  SELECT observation FROM search.public_filter_observation
  WHERE (partition_no,observation)=(:partition_no::integer,:observation::text)
    AND state='open' AND consumer_work=:old_work::text FOR UPDATE
), advanced AS (
  UPDATE search.public_filter_execution SET repair_settlement=:settlement::text
  WHERE (partition_no,observation,id)=(:partition_no::integer,:observation::text,:execution::text)
    AND repair_settlement IS NOT DISTINCT FROM :previous::text
    AND EXISTS (SELECT 1 FROM locked) RETURNING id
) UPDATE search.public_filter_observation SET consumer_work=:next_work::text
WHERE (partition_no,observation)=(:partition_no::integer,:observation::text)
  AND EXISTS (SELECT 1 FROM advanced) RETURNING observation;
