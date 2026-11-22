import startBuild from './public-filter-projection-build-start.sql';

// The candidate Records and their heads were read before Access and foreign-owner
// checks. Compare the complete source observation again in the write snapshot.
const currentSource = `SELECT 1 FROM core.partition p
 JOIN semantic.public_filter_privacy_head h ON h.partition_no=p.partition_no
 JOIN semantic.subject s ON (s.route,s.subject_id)=($2,$3)
 WHERE p.partition_no=$1 AND p.write_state='active' AND p.epoch=$4 AND p.position >= $5
 AND h.position=$6 AND s.type=$7 AND s.visibility=$8 AND s.security_revision=$9
 AND s.current_release IS NOT DISTINCT FROM $10
 AND (SELECT d.target FROM semantic.redirect d WHERE (d.route,d.subject_id)=($2,$3)
      ORDER BY d.sequence DESC LIMIT 1) IS NOT DISTINCT FROM $11::uuid
 AND (SELECT r.revision FROM semantic.revision r WHERE (r.route,r.subject_id)=($2,$3)
      ORDER BY r.revision DESC LIMIT 1) IS NOT DISTINCT FROM $12::integer
 AND COALESCE((SELECT a.ready FROM semantic.search_selection_state a
               WHERE (a.route,a.subject_id) BETWEEN ($2,$3) AND ($2,$3)
               ORDER BY a.route,a.subject_id LIMIT 1),false)=$13`;

const lockedSourceBuild = `source AS MATERIALIZED (${currentSource}), prior AS MATERIALIZED (
   SELECT b.*, EXISTS (
     SELECT 1 FROM semantic.identity_epoch_mapping m JOIN semantic.identity_epoch_group g
       ON (g.partition_no,g.terminal)=(m.control_partition,m.control_group)
     WHERE (m.route,m.original)=(b.route,b.subject_id) AND g.pending_job IS NOT NULL
   ) AS identity_pending
   FROM semantic.public_filter_projection_build b
   WHERE (b.partition_no,b.subject_id)=($1,$3) AND EXISTS (SELECT 1 FROM source)
   FOR UPDATE OF b
 )`;

// Limit the read itself, including the full-window case. A full window may
// need an empty successor to certify EOF. The build lock excludes head writers.
const reclaimHeads = (limit: string) => `sample AS MATERIALIZED (
   SELECT heads.tid FROM work
   CROSS JOIN LATERAL (
     SELECT h.ctid AS tid FROM semantic.public_filter_projection_head h
     WHERE (h.build_id,h.partition_no) BETWEEN (work.build_id,0) AND (work.build_id,4095)
     ORDER BY h.build_id,h.partition_no LIMIT ${limit}
   ) heads
 ), removed AS (
   DELETE FROM semantic.public_filter_projection_head h
   WHERE h.ctid=ANY(ARRAY(SELECT tid FROM sample)) RETURNING partition_no
 ), charge AS MATERIALIZED (SELECT count(*)::integer AS n FROM removed)`;

const retainedHeadsCurrent = `NOT EXISTS (
 SELECT 1 FROM jsonb_to_recordset(r.heads) original(partition_no integer,owner_epoch integer,position bigint)
 LEFT JOIN LATERAL (
   SELECT p.epoch,p.write_state FROM core.partition p
   WHERE p.partition_no BETWEEN original.partition_no AND original.partition_no ORDER BY p.partition_no LIMIT 1
 ) p ON true
 LEFT JOIN LATERAL (
   SELECT h.owner_epoch,h.position FROM semantic.public_filter_privacy_head h
   WHERE h.partition_no BETWEEN original.partition_no AND original.partition_no ORDER BY h.partition_no LIMIT 1
 ) h ON true
 WHERE (p.epoch,p.write_state,h.owner_epoch,h.position)
       IS DISTINCT FROM (original.owner_epoch,'active'::text,original.owner_epoch,original.position)
)`;

export const prepareProjectionBuildSql = `WITH ${lockedSourceBuild}, matched AS MATERIALIZED (
   SELECT r.* FROM prior b JOIN semantic.public_filter_projection_reclamation r USING (partition_no,subject_id)
   WHERE NOT b.identity_pending AND b.meaning_digest='retiring'
     AND (r.build_id,r.generation,r.meaning_digest,r.source_key,r.input_limit)=
         (b.build_id,b.generation,$14,$15,$17)
     AND (r.source->>'position')::bigint <= $5 AND ${retainedHeadsCurrent}
 ), work AS MATERIALIZED (
   SELECT b.build_id FROM prior b WHERE NOT b.identity_pending AND NOT EXISTS (SELECT 1 FROM matched)
 ), ${reclaimHeads('$20')}, marked AS (
   UPDATE semantic.public_filter_projection_build b SET meaning_digest='retiring',generation=b.generation+1
   FROM work,charge WHERE b.build_id=work.build_id AND $20>0 AND charge.n=$20
   RETURNING b.partition_no,b.subject_id,b.build_id,b.generation
 ), opened AS (
   INSERT INTO semantic.public_filter_projection_reclamation
     (partition_no,subject_id,build_id,generation,successor,meaning_digest,source_key,source,heads,input_limit,step)
   SELECT partition_no,subject_id,build_id,generation,$16,$14,$15,$18::jsonb,$19::jsonb,$17,0 FROM marked
   ON CONFLICT (partition_no,subject_id) DO UPDATE SET
     build_id=EXCLUDED.build_id,generation=EXCLUDED.generation,successor=EXCLUDED.successor,
     meaning_digest=EXCLUDED.meaning_digest,source_key=EXCLUDED.source_key,source=EXCLUDED.source,heads=EXCLUDED.heads,input_limit=EXCLUDED.input_limit,step=0
   RETURNING *
 ), cleanup AS (SELECT * FROM matched UNION ALL SELECT * FROM opened)
 SELECT COALESCE((SELECT identity_pending FROM prior),false) AS identity_pending,
   ($20=0 AND EXISTS (SELECT 1 FROM work)) AS no_budget,charge.n AS charged,r.source,
   r.build_id::text AS build,r.generation::text,r.successor::text,r.step
 FROM source CROSS JOIN charge LEFT JOIN cleanup r ON true`;

export const advanceProjectionCleanupSql = `WITH ${lockedSourceBuild}, original AS MATERIALIZED (
   SELECT r.*,b.identity_pending,
     (b.build_id,b.generation,b.meaning_digest)=(r.successor,r.generation+1,r.meaning_digest) AS installed
   FROM prior b JOIN semantic.public_filter_projection_reclamation r USING (partition_no,subject_id)
   WHERE (r.meaning_digest,r.source_key,r.successor,r.input_limit,r.build_id,r.generation)=($14,$15,$16,$17,$18,$19)
     AND ((b.build_id,b.generation,b.meaning_digest)=(r.build_id,r.generation,'retiring')
          OR (b.build_id,b.generation,b.meaning_digest)=(r.successor,r.generation+1,r.meaning_digest))
     AND r.step >= $20 AND (r.source->>'position')::bigint <= $5 AND ${retainedHeadsCurrent}
 ), work AS MATERIALIZED (
   SELECT build_id FROM original WHERE NOT identity_pending AND NOT installed AND step=$20
 ), ${reclaimHeads('$21')}, advanced AS (
   UPDATE semantic.public_filter_projection_reclamation r SET step=r.step+1
   FROM work,charge WHERE (r.partition_no,r.subject_id)=($1,$3) AND r.build_id=work.build_id AND charge.n>0
   RETURNING r.step
 )
 SELECT o.identity_pending,o.installed,o.step,charge.n AS charged,o.source,
   (SELECT step FROM advanced) AS advanced,
   CASE WHEN o.installed THEN b.generation::text END AS installed_generation
 FROM original o CROSS JOIN charge JOIN prior b ON true`;

// A fresh build UUID has no prior head rows. RETURNING carries the actual
// inserted or advanced generation, including when this replaces an older build.
export const startProjectionWithHeadsSql = `WITH build AS (
 ${startBuild.sql.trim().replace(/;$/, '')}
 ), heads AS (
   INSERT INTO semantic.public_filter_projection_head (build_id,partition_no,owner_epoch,position)
   SELECT build.build_id::uuid,h.partition_no,h.owner_epoch,h.position FROM build
   CROSS JOIN jsonb_to_recordset($${startBuild.params.length + 1}::jsonb)
     AS h(partition_no integer,owner_epoch integer,position bigint)
 )
 SELECT build_id,generation,route FROM build`;

export const retainCurrentProjectionHeadsSql = `WITH source AS MATERIALIZED (${currentSource}),
 build AS MATERIALIZED (
   SELECT b.build_id FROM semantic.public_filter_projection_build b
   WHERE (b.build_id,b.generation)=($14,$15) AND b.meaning_digest<>$16
     AND EXISTS (SELECT 1 FROM source) FOR SHARE OF b
 ), heads AS (
   INSERT INTO semantic.public_filter_projection_head (build_id,partition_no,owner_epoch,position)
   SELECT build.build_id,h.partition_no,h.owner_epoch,h.position FROM build
   CROSS JOIN jsonb_to_recordset($17::jsonb) AS h(partition_no integer,owner_epoch integer,position bigint)
   ON CONFLICT (build_id,partition_no) DO UPDATE
   SET owner_epoch=EXCLUDED.owner_epoch,position=EXCLUDED.position
   WHERE (public_filter_projection_head.owner_epoch,public_filter_projection_head.position)=
         (EXCLUDED.owner_epoch,EXCLUDED.position)
   RETURNING partition_no
 )
 SELECT (SELECT count(*)::integer FROM heads) AS retained FROM build`;

export const readCurrentProjectionHeadPageSql = `WITH retained AS MATERIALIZED (
 SELECT partition_no,owner_epoch,position FROM semantic.public_filter_projection_head
 WHERE (build_id,partition_no)>($1::uuid,$2::integer)
   AND (build_id,partition_no)<=($1::uuid,4095)
 ORDER BY build_id,partition_no LIMIT $3
 )
 SELECT r.partition_no,r.owner_epoch,r.position::text,
   COALESCE(p.write_state='active' AND p.epoch=r.owner_epoch
     AND h.owner_epoch=r.owner_epoch AND h.position=r.position,false) AS current
 FROM retained r
 LEFT JOIN LATERAL (
   SELECT p.epoch,p.write_state FROM core.partition p
   WHERE p.partition_no BETWEEN r.partition_no AND r.partition_no ORDER BY p.partition_no LIMIT 1
 ) p ON true
 LEFT JOIN LATERAL (
   SELECT h.owner_epoch,h.position FROM semantic.public_filter_privacy_head h
   WHERE h.partition_no BETWEEN r.partition_no AND r.partition_no ORDER BY h.partition_no LIMIT 1
 ) h ON true ORDER BY r.partition_no`;

export const checkProjectionCleanupSql = `SELECT
 ((b.build_id,b.generation,b.meaning_digest)=(r.build_id,r.generation,'retiring')
  OR (b.build_id,b.generation,b.meaning_digest)=(r.successor,r.generation+1,r.meaning_digest))
 AND NOT EXISTS (
   SELECT 1 FROM semantic.identity_epoch_mapping m JOIN semantic.identity_epoch_group g
     ON (g.partition_no,g.terminal)=(m.control_partition,m.control_group)
   WHERE (m.route,m.original)=(b.route,b.subject_id) AND g.pending_job IS NOT NULL
 )
 AND r.meaning_digest=$5 AND r.source=$6::jsonb
 AND EXISTS (SELECT 1 FROM jsonb_to_recordset(r.heads) h(partition_no integer) WHERE h.partition_no=$1)
 AND EXISTS (SELECT 1 FROM jsonb_to_recordset(r.heads) h(partition_no integer) WHERE h.partition_no=$7)
 AND ${retainedHeadsCurrent} AS current
 FROM semantic.public_filter_projection_reclamation r
 JOIN semantic.public_filter_projection_build b USING (partition_no,subject_id)
 WHERE (r.partition_no,r.subject_id,r.successor,r.generation)=($1,$2,$3,$4::bigint-1)`;
