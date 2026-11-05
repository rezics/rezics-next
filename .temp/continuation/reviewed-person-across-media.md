# Continue reviewed Person across media

Goal: imports  
Manager: imports

## Delivered

- Recorded the routed reviewer decision in the import-review owner: exact source IDs select records; independently cited human evidence and explicit confirmation establish the bridge.
- Added importer coverage for the public Jun Maeda discovery candidate: Bangumi `person:1916` and VNDB `s224`, with the Bangumi `Angel Beats!` source page and VNDB `CLANNAD` source page. CDJournal's profile is independent review evidence. Names and credits remain discovery evidence only.
- Documented current-identifier checks and original source-binding retention in the importer owner.

## Remaining

- The named VNDB archive (`VNDBvndb-db-2026-11-04.tar.zst`, SHA-256 `fadbe611c4d6475ef63a0c1861512bc9ff64d21c6c9804a988522c7c65f6fa85`) and Bangumi dump (`dump-2026-10-20.210332Z`) were not present in the worktree or the read-only main checkout. Use the existing operators on those exact inputs to capture source text, row citations, pinned digests, original native UUIDs and the final selected pair; the live public candidate above is not pinned-dump evidence.
- The base has no Semantic producer support for `reviewIdentitySource`/`reviewIdentityExternalId`, coherent `reviewedIdentity` GET output, or paired `expectedIdentity` merge guard. Bind the delivered generated client signatures and native error shapes when that owner lands; do not add an Imports-side guard.
- Complete the existing Web reviewer-to-merge caller and sole seed composition with those returned source keys, original UUIDs and digests. Add and run `services/kernel/test/imports/m1-person-across-media.test.ts` for current public Person/credit reads, stable bindings on reopen and changed credits, and the namesake, Organization, stale-review, withdrawn-identifier and current-authority cases.
- Verify the native, browser, fresh-stack, source-statistics, Bangumi conversion and growth acceptance after integration.
