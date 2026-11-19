-- migrate:up
-- Earlier admissions have no separate Accounts reader allowance.
CREATE FUNCTION core.identity_original_sum(a bigint[], b bigint[], c bigint[], d bigint[], e bigint[])
RETURNS bigint[] LANGUAGE sql IMMUTABLE AS $$
 SELECT array_agg(a[i]+coalesce(b[i],0)+coalesce(c[i],0)+d[i]+coalesce(e[i],0) ORDER BY i)
 FROM generate_series(1,8) i
$$;

ALTER TABLE core.identity_history_allocation
 ADD COLUMN accounts_work bigint[] CHECK(accounts_work IS NULL OR core.identity_original_vector_valid(accounts_work) IS TRUE),
 DROP CONSTRAINT identity_history_allocation_check,
 ADD CONSTRAINT identity_history_allocation_check
   CHECK(parent_work=core.identity_original_sum(local_work,source_work,library_work,transfer_work,accounts_work));

DROP FUNCTION core.identity_original_sum(bigint[], bigint[], bigint[], bigint[]);

-- migrate:down
-- Forward only: admitted Accounts work remains part of the immutable prepaid total.
