SELECT change_id,effective_at::text,evidence FROM semantic.subject_page_continuation
WHERE route=:route::integer AND subject_id=:subject_id::uuid AND kind=:kind::text;
