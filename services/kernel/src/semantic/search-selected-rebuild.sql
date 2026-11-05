-- unbound: one-subject search_rebuild_one
SELECT semantic.search_rebuild_one(:route::integer, :subject_id::uuid) AS ready;
