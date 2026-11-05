SELECT max(effective_at)::text AS effective_at FROM semantic.subject_page_delivery
WHERE route=:route::integer AND subject_id=:subject_id::uuid AND evidence='known';
