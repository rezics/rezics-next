SELECT revision,source FROM semantic.revision
WHERE route=:route::integer AND subject_id=:subject_id::uuid AND revision=ANY(:revisions::integer[]);
