WITH observation AS MATERIALIZED (
  SELECT partition_no,observation,consumer_work,consumer_bootstrap,registration
  FROM search.public_filter_observation
  WHERE (partition_no,observation)=($1,$2)
  FOR SHARE
)
SELECT e.repair_settlement,o.consumer_work,o.consumer_bootstrap,o.registration
FROM search.public_filter_execution e
JOIN observation o ON (o.partition_no,o.observation)=(e.partition_no,e.observation)
WHERE (e.partition_no,e.observation,e.id)=($1,$2,$3)
FOR UPDATE OF e
