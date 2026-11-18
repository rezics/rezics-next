-- unbound: a complete small explicit-entry population on the current owner home, including its EOF probe.
WITH owner AS MATERIALIZED (
  SELECT h.route,h.account_id,h.generation::text AS version,p.epoch,p.position::text,counts.n::integer AS n,
         a.kind,a.state,a.authn_fenced AS fenced,a.minimum_authn_epoch::text AS floor
  FROM library.fact_source_head h
  JOIN access.account a USING (route,account_id)
  JOIN core.partition p ON p.partition_no=$4 AND p.write_state='active' AND p.moved_to IS NULL
  JOIN library.owner_index_control idx USING (route,account_id)
  JOIN library.shelf_maintenance shelf USING (route,account_id)
  JOIN library.shelf_count counts ON (counts.route,counts.account_id,counts.generation_id)=
      (shelf.route,shelf.account_id,shelf.active_generation)
  WHERE (h.route,h.account_id)=($1,$2) AND idx.phase='ready' AND idx.personal_coverage_ready
    AND shelf.initialized AND shelf.ready AND shelf.mode='open'
    AND counts.bucket='all' AND counts.type_id='00000000-0000-0000-0000-000000000000'
    AND counts.n BETWEEN 1 AND $5
    AND NOT EXISTS (SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$3)
    AND NOT EXISTS (SELECT 1 FROM library.builtin_collection_reference WHERE route=$1 AND collection_id=$3)
    AND NOT EXISTS (SELECT 1 FROM library.owner_index_pin WHERE route=$1 AND account_id=$2 AND NOT meaning_ready)
    AND NOT EXISTS (SELECT 1 FROM library.owner_index_label_repair WHERE route=$1 AND account_id=$2)
    AND NOT EXISTS (SELECT 1 FROM library.entry_clear WHERE route=$1 AND account_id=$2)
    AND NOT EXISTS (SELECT 1 FROM library.entry_personal_fact WHERE route=$1 AND account_id=$2
       AND (note IS NOT NULL OR priority IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM library.entry_source_observation WHERE route=$1 AND account_id=$2)
    AND NOT EXISTS (SELECT 1 FROM library.progress_session WHERE route=$1 AND account_id=$2 AND state<>'retired')
    AND NOT EXISTS (SELECT 1 FROM library.copy WHERE route=$1 AND account_id=$2 AND deletion_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND deleted_at IS NULL)
)
SELECT o.version,o.epoch,o.position,o.n,o.kind,o.state,o.fenced,o.floor,e.id,e.explicit
FROM owner o LEFT JOIN LATERAL (
  SELECT subject_id AS id,state IS NOT NULL AS explicit FROM library.entry
  WHERE route=o.route AND account_id=o.account_id ORDER BY subject_id LIMIT o.n+1
) e ON true ORDER BY e.id;
