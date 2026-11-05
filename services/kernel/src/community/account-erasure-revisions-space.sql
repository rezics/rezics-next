-- Lock the owner head against ordinary concurrent edits before disposing of the exact revision.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :owner_id::uuid AS owner_id,
         :revision_id::uuid AS revision_id, :account_id::uuid AS account_id
), owner AS MATERIALIZED (
  SELECT o.head_revision_id FROM community.space o CROSS JOIN input i
  WHERE o.route = i.route AND o.space_id = i.owner_id
  FOR UPDATE OF o
)
UPDATE community.space_revision r SET title = '', summary = ''
FROM owner CROSS JOIN input i
WHERE r.route = i.route AND r.revision_id = i.revision_id
  AND r.space_id = i.owner_id AND r.author = i.account_id
  AND r.revision_id <> owner.head_revision_id
RETURNING r.revision_id;
