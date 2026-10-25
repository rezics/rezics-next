-- The head carries the new revision's votes, as it carries that revision's visibility and context.
-- The revision id is named once. A missing revision makes the vote lookup null and the
-- update fails the votes check; callers insert that revision before moving the head.
UPDATE community.realm
SET (head_revision_id, votes) = (
      SELECT chosen.revision_id,
             community.realm_revision_votes(community.realm.route, community.realm.realm_id, chosen.revision_id)
      FROM (SELECT :revision::uuid AS revision_id) AS chosen
    ),
    visibility = :visibility::text,
    context_id = :context::uuid
WHERE route = :route::integer AND realm_id = :id::uuid
  AND head_revision_id = :expected::uuid AND state = 'active'
RETURNING realm_id;
