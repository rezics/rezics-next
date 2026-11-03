WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :parent_id::uuid AS parent_id
), keys AS MATERIALIZED (
 SELECT kind, id FROM (
  SELECT 'manual'::text AS kind, child.unit_id AS id FROM library.progress_unit child, input
  WHERE child.route=input.route AND child.session_id=input.parent_id
  UNION ALL
  SELECT 'episode', child.episode_subject_id::text FROM library.progress_episode child, input
  WHERE child.route=input.route AND child.session_id=input.parent_id
 ) children
 WHERE EXISTS (SELECT 1 FROM library.progress_session parent, input
  WHERE parent.route=input.route AND parent.account_id=input.account_id AND parent.session_id=input.parent_id)
 ORDER BY kind, id LIMIT 100
), manual AS (
 DELETE FROM library.progress_unit victim USING keys, input
 WHERE victim.route=input.route AND victim.session_id=input.parent_id AND keys.kind='manual' AND victim.unit_id=keys.id
 RETURNING true AS removed
), episodes AS (
 DELETE FROM library.progress_episode victim USING keys, input
 WHERE victim.route=input.route AND victim.session_id=input.parent_id AND keys.kind='episode'
  AND victim.episode_subject_id=CASE WHEN keys.kind='episode' THEN keys.id::uuid END
 RETURNING true AS removed
)
SELECT removed FROM manual UNION ALL SELECT removed FROM episodes;
