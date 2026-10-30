WITH input AS NOT MATERIALIZED (SELECT :effective_at::nullable(timestamptz) AS effective_at)
UPDATE semantic.subject_page_publication SET generation=:generation::bigint,
readiness=:readiness::text, completed_position=:completed_position::bigint, change_position=:position::bigint,
public_effective_at=GREATEST(public_effective_at,(SELECT effective_at FROM input)),
evidence=CASE WHEN public_effective_at IS NOT NULL OR (SELECT effective_at FROM input) IS NOT NULL THEN 'known' ELSE 'missing' END,
witnesses=:witnesses::jsonb WHERE route=:route::integer AND subject_id=:subject_id::uuid RETURNING subject_id::text;
