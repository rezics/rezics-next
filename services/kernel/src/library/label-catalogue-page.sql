-- Correlated bounded branches retain index predicates under generic prepared plans.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :after_label_id::uuid AS after_label_id, :limit::integer AS page_limit
), source AS MATERIALIZED (
  SELECT a.* FROM input CROSS JOIN LATERAL (
    SELECT label_id AS id, normalized_name AS name, revision, deleted_at::text AS "deletedAt"
    FROM library.personal_label
    WHERE route = input.route AND account_id = input.account_id AND label_id > input.after_label_id
    ORDER BY label_id
    LIMIT input.page_limit
  ) a
)
SELECT * FROM source ORDER BY id;
