/** Bounded input projection shared with Library's selected identity planner. */
export declare const identityEpochLibraryInputsSQL = "SELECT generation,terminal,control_partition FROM semantic.identity_epoch_input WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 3";
