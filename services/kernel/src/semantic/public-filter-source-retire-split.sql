/* semantic.native-keyed:10:20:3 */
WITH originals AS MATERIALIZED (
  SELECT r.partition_no,r.id,loser.observation AS losing,winner.observation AS winning,
         loser.state AS losing_state,winner.state AS winning_state,
         loser.queried AS losing_query,winner.queried AS winning_query
  FROM semantic.public_filter_bootstrap b
  JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.owner_epoch AND p.write_state='active'
  JOIN search.public_filter_registration r ON (r.partition_no,r.id)=(b.partition_no,$2)
  JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
  JOIN search.public_filter_observation loser ON (loser.partition_no,loser.observation)=(r.partition_no,$3)
  JOIN search.public_filter_observation winner ON (winner.partition_no,winner.observation)=(r.partition_no,b.queried)
  WHERE (b.partition_no,b.bootstrap)=(0,$1) AND b.state='adopted' AND b.snapshot_kind='pit'
    AND b.publication_job IS NULL AND b.coverage_publication IS NOT NULL AND b.consumer=$7
    AND r.state='active' AND r.consumer_bootstrap=$4 AND r.consumer_work=$5 AND r.consumer=$10 AND t.incarnation=$11
    AND b.queried<>$3 AND loser.queried=$6 AND loser.registration=r.id AND winner.registration=r.id
    AND loser.covered=$8 AND winner.covered=loser.covered
    AND loser.prepared_build IS NULL AND winner.prepared_build IS NULL
    AND loser.prepared_rows IS NULL AND winner.prepared_rows IS NULL
    AND loser.consumer_work IS NULL AND loser.consumer_bootstrap IS NULL
    AND winner.consumer_work IS NULL AND winner.consumer_bootstrap IS NULL
    AND loser.expires_at<=$9 AND winner.expires_at<=$9
  FOR UPDATE OF r,loser,winner
), fenced AS (
  UPDATE search.public_filter_observation o SET state='closing' FROM originals x
  WHERE o.partition_no=x.partition_no AND o.observation IN (x.losing,x.winning) AND o.state='open'
  RETURNING o.observation
), cleared AS (
  UPDATE search.public_filter_registration r SET consumer_bootstrap=NULL,consumer_work=NULL
  FROM originals x WHERE (r.partition_no,r.id)=(x.partition_no,x.id)
    AND x.losing_state='closed' AND x.winning_state='closed'
  RETURNING r.id
)
SELECT ARRAY(SELECT q.queried FROM (VALUES
    (x.losing,x.losing_state,x.losing_query),(x.winning,x.winning_state,x.winning_query)
  ) q(id,state,queried) WHERE q.state<>'closed' ORDER BY q.id) AS closing,
       (SELECT count(*)::integer FROM fenced) AS writes,EXISTS(SELECT FROM cleared) AS released
FROM originals x
