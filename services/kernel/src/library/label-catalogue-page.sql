-- Correlated bounded branches retain index predicates under generic prepared plans.
-- ORDER BY names the primary key so the range cannot Seq Scan the owner catalogue.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :after_label_id::uuid AS after_label_id, :limit::integer AS page_limit
), source AS MATERIALIZED (
  SELECT a.* FROM input CROSS JOIN LATERAL (
    SELECT label.label_id AS id, label.normalized_name AS name, label.revision,
           label.deleted_at::text AS "deletedAt"
    FROM library.personal_label AS label
    WHERE label.route = input.route AND label.account_id = input.account_id
      AND label.label_id > input.after_label_id
    ORDER BY label.route, label.account_id, label.label_id
    LIMIT input.page_limit
  ) a
)
SELECT * FROM source ORDER BY id;
