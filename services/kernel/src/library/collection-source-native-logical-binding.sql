WITH input AS NOT MATERIALIZED (
  SELECT $1::integer AS route,
         $2::uuid AS account_id,
         $3::uuid AS collection_id,
         $4::integer AS partition_no
)
SELECT account.route AS "accountRoute",
       account.account_id AS "accountId",
       account.kind AS "accountKind",
       account.state AS "accountState",
       account.authn_fenced AS fenced,
       account.minimum_authn_epoch::text AS "minimumAuthnEpoch",
       partition.write_state AS "partitionState",
       partition.epoch AS "partitionEpoch",
       partition.position::text AS "partitionPosition",
       head.generation::text AS "sourceVersion",
       control.phase AS "ownerIndexPhase",
       EXISTS (
         SELECT 1 FROM library.owner_index_pin pin
         WHERE pin.route = input.route AND pin.account_id = input.account_id AND NOT pin.meaning_ready
       ) AS "pendingOwnerPin",
       reference.account_id AS "referenceAccountId",
       reference.profile_id AS "profileId",
       reference.state_set_id AS "stateSetId",
       reference.state_id AS "stateId",
       EXISTS (
         SELECT 1 FROM library.owner_index_state state
         WHERE state.route = input.route AND state.account_id = input.account_id
           AND state.collection_id = input.collection_id
       ) AS "stateSupported",
       COALESCE(liked.version, 0::bigint)::text AS "likedVersion"
FROM input
LEFT JOIN access.account account
  ON account.route = input.route AND account.account_id = input.account_id
LEFT JOIN core.partition partition
  ON partition.partition_no = input.partition_no
LEFT JOIN library.fact_source_head head
  ON head.route = input.route AND head.account_id = input.account_id
LEFT JOIN library.owner_index_control control
  ON control.route = input.route AND control.account_id = input.account_id
LEFT JOIN library.builtin_collection_reference reference
  ON reference.route = input.route AND reference.collection_id = input.collection_id
LEFT JOIN content.reaction_liked_version liked
  ON liked.route = input.route AND liked.actor_account_id = input.account_id;
