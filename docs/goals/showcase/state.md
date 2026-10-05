# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-05 16:40 CST) |
| --- | --- |
| Done | Decision 54 in its owners. Merged and closed: G-1109 width renditions (c7b1e8d68; migration 760); G-1110 Work showcase art (d114526a2; migration 770); G-1108 stage and layered slides with v2 consumption and Work art fallback (fb4b355a2, 7266d739b) carrying G-1111's v2 slides (12871d4c2; G-1111 closed as cancelled because its commit landed through G-1108); derived artifacts and the Fuseki pin regenerated (cce5f5e07); literal unions in the showcase art contract (ebfc2b067); rate-limit families for the showcase routes (4294af60c), reported by the regression holder. |
| Running | G-1123 Work showcase art editor (Opus xhigh, attempt 2 after a rebase onto ebfc2b067); G-1125 Work page header and dev seeds (Sonnet high). |
| Next | Shared stack refreshed at 15:35 (model generation 90ba794e, Main ready, no Zone approvals pending); the Fiction Zone home shows the new stage with cover-composed slides at 390 and 1280 px. On G-1123 and G-1125: review screenshots, merge, refresh the stack, see the seeded art on the Zone hero and Work page. Dispatch G-1124 (Realm editor) after G-1123 (post-layers has closed, so `manage/**` is free). Wave QA `test --affected 932ada68c` pinned in a worktree. Follow-ups: batch author proofs (`access/author-baseline.ts`, after G-1081); the anti-silo check passes on main again (16:45), so no anti-silo task is needed. |
| Regression | Agreed with scoped-subjects (rezics-next-97): main-wide regression passes to this Goal when scoped-subjects closes, with its written state. |
| Lessons | Commit untracked generated files too after `task gen` (two v2 model artifacts were left untracked until 0f6d0ffb1). A manager polling for the heavy lock must run the refresh in the same step. Docker Desktop died 15:50–15:54 under memory pressure (about 1 GB free) with two worker web dev servers up (about 4.8 GB together); QA results from 15:50–16:05 are void. The next frontend wave shares one manager-run dev server. |
| Usage | Claude dispatch open again (week projected under the cap): Opus and Sonnet for frontend, Sol for backend. |
