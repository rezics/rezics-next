WITH args AS (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :after_id::nullable(uuid) AS after_id, :limit::integer AS page_limit
), selected AS MATERIALIZED (
  SELECT log.route, log.log_id FROM library.published_log AS log CROSS JOIN args
  WHERE log.route=args.route AND log.account_id=args.account_id
    AND (args.after_id IS NULL OR log.log_id > args.after_id)
  ORDER BY log.log_id LIMIT (SELECT page_limit FROM args)
  FOR UPDATE
), removed AS (
  DELETE FROM library.published_log AS log USING selected
  WHERE log.route=selected.route AND log.log_id=selected.log_id
  RETURNING log.log_id
)
SELECT log_id AS id, true AS removed FROM removed ORDER BY log_id;
