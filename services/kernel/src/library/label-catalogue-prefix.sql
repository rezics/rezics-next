-- Live names are unique per owner, so name ordering also orders (name,label_id).
-- Correlated bounded branches retain index predicates under generic prepared plans.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :prefix::text COLLATE "C" AS prefix, :upper::nullable(text) COLLATE "C" AS upper_bound,
         :after_name::text COLLATE "C" AS after_name, :after_label_id::uuid AS after_label_id,
         :limit::integer AS page_limit
), bounded AS MATERIALIZED (
  SELECT a.* FROM input CROSS JOIN LATERAL (
    SELECT label_id AS id, normalized_name AS name, revision, deleted_at::text AS "deletedAt"
    FROM library.personal_label
    WHERE route = input.route AND account_id = input.account_id AND deleted_at IS NULL
      AND normalized_name COLLATE "C" >= input.prefix
      AND normalized_name COLLATE "C" < input.upper_bound
      AND normalized_name COLLATE "C" >= input.after_name
      AND (normalized_name COLLATE "C", label_id) > (input.after_name, input.after_label_id)
    ORDER BY normalized_name COLLATE "C" LIMIT input.page_limit
  ) a WHERE input.upper_bound IS NOT NULL
  UNION ALL
  SELECT a.* FROM input CROSS JOIN LATERAL (
    SELECT label_id AS id, normalized_name AS name, revision, deleted_at::text AS "deletedAt"
    FROM library.personal_label
    WHERE route = input.route AND account_id = input.account_id AND deleted_at IS NULL
      AND normalized_name COLLATE "C" >= input.prefix
      AND normalized_name COLLATE "C" >= input.after_name
      AND (normalized_name COLLATE "C", label_id) > (input.after_name, input.after_label_id)
    ORDER BY normalized_name COLLATE "C" LIMIT input.page_limit
  ) a WHERE input.upper_bound IS NULL
)
SELECT * FROM bounded ORDER BY name COLLATE "C";
