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
