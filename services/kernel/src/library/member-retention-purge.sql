-- member-retention: physical exact episode
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id, :member_id::uuid AS member_id,
         :deletion_id::uuid AS deletion_id, :expected_purge_after::timestamptz AS expected_purge_after,
         :time::timestamptz AS time
), target AS MATERIALIZED (
  SELECT member.route, member.collection_id, member.member_id, collection.visibility, collection.state
  FROM library.collection_member member JOIN library.collection collection
    ON collection.route=member.route AND collection.collection_id=member.collection_id
  CROSS JOIN input
  WHERE member.route=input.route AND member.collection_id=input.collection_id AND member.member_id=input.member_id
    AND member.deletion_id=input.deletion_id AND member.purge_after=input.expected_purge_after
    AND member.purge_after<=input.time
), removed AS (
  DELETE FROM library.collection_member member USING input,target
  WHERE member.route=input.route AND member.collection_id=input.collection_id AND member.member_id=input.member_id
    AND (target.state='deleted' OR (target.state='active' AND target.visibility<>'public'))
  RETURNING true AS purged
), minimized AS (
  UPDATE library.collection_member member SET note=NULL,added_at=NULL,deletion_revision=NULL,deleted_at=NULL,purge_after=NULL
  FROM input,target
  WHERE member.route=input.route AND member.collection_id=input.collection_id AND member.member_id=input.member_id
    AND target.state='active' AND target.visibility='public'
  RETURNING true AS purged
)
SELECT true AS purged WHERE EXISTS(SELECT 1 FROM removed UNION ALL SELECT 1 FROM minimized);
