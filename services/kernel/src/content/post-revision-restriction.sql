-- One exact revision and its owning Post are resolved by the routed key. The
-- Post lock fences all prepared native reads through its security revision.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :post_id::uuid AS post_id, :revision_id::uuid AS revision_id
), target AS MATERIALIZED (
  SELECT p.route, p.thread_id, p.post_id, r.revision_id, r.board_id
  FROM input i
  JOIN content.post p ON p.route=i.route AND p.post_id=i.post_id
  JOIN content.revision r ON r.route=p.route AND r.thread_id=p.thread_id
    AND r.post_id=p.post_id AND r.revision_id=i.revision_id
  WHERE p.visibility <> 'taken_down' AND p.availability='available' AND r.availability='available'
    AND NOT EXISTS (
      SELECT 1 FROM content.post_revision_restriction active
      WHERE active.route=r.route AND active.revision_id=r.revision_id AND active.lifted_at IS NULL
    )
  FOR UPDATE OF p
), changed AS (
  UPDATE content.post p SET security_revision=p.security_revision+1
  FROM target t
  WHERE p.route=t.route AND p.post_id=t.post_id
  RETURNING p.route, p.thread_id, p.post_id, t.revision_id, t.board_id, p.security_revision::text
)
SELECT * FROM changed;
