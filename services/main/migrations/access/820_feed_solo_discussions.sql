-- A discussion or reply is a post of its own, as on Reddit: never grouped
-- under another, so every discussion appears on Home and every reply takes
-- votes (only a group's leading activity does). Refresh stops grouping them;
-- this promotes the ones grouped before, each to its own one-member group with
-- the key it would have had alone (`digest(['home-group-v1', id])` in
-- feed/store.ts), and trims their former leaders to themselves. Scores and
-- votes stay on the activity that received them. Replaying it changes nothing.
UPDATE access.feed_item
SET group_leader = true, group_members = ARRAY[id],
  group_bucket = encode(sha256(convert_to('["home-solo-v1",' || to_json(id)::text || ']', 'UTF8')), 'hex'),
  group_key = encode(sha256(convert_to('["home-group-v1",' || to_json(id)::text || ']', 'UTF8')), 'hex')
WHERE kind IN ('discussion', 'reply') AND NOT group_leader;

UPDATE access.feed_item
SET group_members = ARRAY[id],
  group_bucket = encode(sha256(convert_to('["home-solo-v1",' || to_json(id)::text || ']', 'UTF8')), 'hex')
WHERE kind IN ('discussion', 'reply') AND group_leader AND group_members <> ARRAY[id];
