export const BUILTIN_NATIVE_PRESENCE_SQL = `SELECT
    EXISTS(SELECT 1 FROM library.entry WHERE route=$1 AND account_id=$2) AS entry,
    EXISTS(SELECT 1 FROM library.progress_session WHERE route=$1 AND account_id=$2 AND state <> 'retired') AS session,
    EXISTS(SELECT 1 FROM library.copy WHERE route=$1 AND account_id=$2 AND deletion_id IS NULL) AS copy,
    EXISTS(SELECT 1 FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND deleted_at IS NULL) AS label`;

export const BUILTIN_STATE_SUCCESSORS_SQL = `WITH RECURSIVE keys(collection_id,n) AS (
          (SELECT collection_id,1 FROM library.owner_index_state
            WHERE route=$1 AND account_id=$2 AND ($3::uuid IS NULL OR collection_id>$3)
            ORDER BY collection_id LIMIT 1)
          UNION ALL
          SELECT next.collection_id,k.n+1 FROM keys k CROSS JOIN LATERAL (
            SELECT collection_id FROM library.owner_index_state
            WHERE route=$1 AND account_id=$2 AND collection_id>k.collection_id
            ORDER BY collection_id LIMIT 1
          ) next WHERE k.n<$4
        )
        SELECT r.profile_id AS "profileId",r.state_set_id AS "stateSetId",r.state_id AS "stateId"
        FROM keys k JOIN library.builtin_collection_reference r
          ON r.route=$1 AND r.collection_id=k.collection_id AND r.account_id=$2
        ORDER BY k.collection_id`;

export const BUILTIN_STATE_LABELS_SQL = `SELECT labels FROM library.owner_index_state WHERE route=$1 AND account_id=$2 AND collection_id=$3
         ORDER BY pin->>'releaseDigest',pin LIMIT 1`;

export const BUILTIN_STORED_COLLECTION_SQL = `SELECT builtin_kind AS kind,curator_account_id AS owner,membership_kind AS membership,state,visibility,
        title,description,revision,presentation_kind AS "presentationKind",cover_media_id AS "coverMediaId"
       FROM library.collection WHERE route=$1 AND collection_id=$2`;
