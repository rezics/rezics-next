# Realm erasure continuity growth

This measurement binds the community Cost row “Apply Realm erasure continuity” to
`services/kernel/test/community/growth-realm-erasure-continuity.test.ts`.

The fixture creates a native Auth persona, creates ordinary, removed and retained-history Realms through the Content
HTTP API, removes one Realm through its lifecycle endpoint, then deletes the persona through the registered
`accountDeletionRuntime` and `deletePersona` path. Each selected Realm step uses the real
`createRealmOwnershipCommands` preparation and `eraseAccountRealmOwnership` command on the released native erasure
root. The captured operation includes the exact `access.realm_erasure_succession` applied-result read, the Content
Realm callback and its conditional Realm update. Setup, native account deletion, selected completion and stable replay
remain distinct.

The test rolls an ordinary Realm segment back before committing it, commits the removed Realm segment, and replays
both without changing their stored source episode or native decision row. It measures the ordinary Realm while
unrelated owner grants, membership intervals and both account-progress tables grow together, then measures the
removed Realm while retained revisions on a separate Realm grow. Both axes use 256, 1024 and 4096 rows. The selected
Realm row and succession decision are fenced at each scale. The page/batch behavior stays at its production default.

The shared growth observer records rows, statements, shared buffer hits and reads, and plan blocks for the selected
operation. The owner bound remains constant Content rows and statements per Realm with logarithmic index blocks;
candidate/frontier preparation remains part of the native operation and is not reported as a bound for the complete
account lifecycle. The fixture seeds only unrelated pressure outside the measured window.

Base revision: `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`. The authored native acceptance command is
`bun run --cwd services/kernel check test/community/growth-realm-erasure-continuity.test.ts`; controller admission
deferred native acceptance in this attempt, so no measured sample is claimed here.
