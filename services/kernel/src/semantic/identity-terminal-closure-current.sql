SELECT g.*
FROM semantic.identity_epoch_group_points($1::integer[],$2::uuid[],$3::uuid[]) g;
