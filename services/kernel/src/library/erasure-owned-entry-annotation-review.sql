-- Review headers own at most sixteen selected operands each; the parent cascade removes their private notes.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT review_id FROM library.entry_annotation_review, input
  WHERE library.entry_annotation_review.route=input.route
    AND library.entry_annotation_review.account_id=input.account_id
  ORDER BY review_id LIMIT 100
)
DELETE FROM library.entry_annotation_review AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.review_id=keys.review_id
RETURNING true AS removed;
