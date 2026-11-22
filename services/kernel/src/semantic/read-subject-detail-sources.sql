-- A Global detail with no statement history, projected links or private disclosures
-- has only terms. Each EXISTS is a prefix seek on this one Subject's partial index.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS id
)
SELECT :global_context::boolean AND NOT EXISTS (
  SELECT 1 FROM semantic.fact AS f
  WHERE f.route = input.route AND f.subject_id = input.id AND kind = 'statement'
) AND NOT EXISTS (
  SELECT 1 FROM semantic.outbound_link AS link
  WHERE link.route = input.route AND link.subject_id = input.id AND present
    AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
) AND NOT EXISTS (
  SELECT 1 FROM semantic.statement_disclosure AS d
  WHERE d.route = input.route AND d.subject_id = input.id AND NOT disclosed
) AS terms_only,
ARRAY(
  SELECT member_id::text FROM semantic.merge_member AS member
  WHERE :include_members::boolean AND member.route = input.route AND member.subject_id = input.id
  ORDER BY member.member_id
) AS members
FROM input;
