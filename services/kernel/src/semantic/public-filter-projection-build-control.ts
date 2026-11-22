/** A retired build remains the sole subject row while its dependency heads are reclaimed. */
export const retiredProjectionMeaning = 'retiring';

export const lockProjectionBuildForRetirementSql = `SELECT build_id::text,generation::text,meaning_digest
 FROM semantic.public_filter_projection_build WHERE (partition_no,subject_id)=($1,$2) FOR UPDATE`;

export const retireProjectionHeadSql = `DELETE FROM semantic.public_filter_projection_head h
 USING (SELECT partition_no FROM semantic.public_filter_projection_head
        WHERE build_id=$1 ORDER BY partition_no LIMIT 1) next
 WHERE (h.build_id,h.partition_no)=($1,next.partition_no) RETURNING h.partition_no`;

export const invalidateProjectionBuildSql = `UPDATE semantic.public_filter_projection_build
 SET generation=generation+1,meaning_digest=$3
 WHERE build_id=$1 AND generation=$2 RETURNING generation::text`;

export const lockProjectionBuildForHeadsSql = `SELECT 1 FROM semantic.public_filter_projection_build
 WHERE build_id=$1 AND generation=$2 AND meaning_digest<>$3 FOR SHARE`;

/** The original subject, projection revision and completed dependency tail in one snapshot. */
export const verifyCompletedPublicFilterProjectionSql = `SELECT 1
 FROM semantic.public_filter_projection_build b
 JOIN semantic.subject s ON (s.route,s.subject_id)=($2,$3)
  AND s.visibility='visible' AND s.security_revision=b.security_revision AND s.current_release=b.current_release
 JOIN semantic.search_selection_state selected ON (selected.route,selected.subject_id)=($2,$3)
  AND selected.ready
 JOIN semantic.public_filter_privacy_head h ON h.partition_no=b.partition_no AND h.position=b.privacy_position
 JOIN LATERAL (
   SELECT revision FROM semantic.revision r WHERE (r.route,r.subject_id)=($2,$3)
   ORDER BY r.revision DESC LIMIT 1
 ) revision ON revision.revision=b.subject_revision
 WHERE (b.partition_no,b.route,b.subject_id,b.build_id,b.generation,b.owner_epoch,b.meaning_digest,b.terminal_id)=
   ($1,$2,$3,$4,$5,$6,$7,$8)
 AND NOT EXISTS (SELECT 1 FROM semantic.public_filter_projection_head d
   WHERE d.build_id=b.build_id AND d.partition_no>$9 LIMIT 1)`;
