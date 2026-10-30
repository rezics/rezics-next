SELECT change_id,effective_at::text,evidence FROM semantic.subject_page_owner WHERE route=:route::integer AND owner_kind=:owner_kind::text AND owner_key=:owner_key::text;
