# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`. Taken over on 2026-10-07 by GPT-6.1 Sol in tmux
`goal-trust-ops`, registered as `goal-trust-ops-codex`. Program manager:
`rezics-next-7b`. The prior handover's contracts and remaining inventory below
remain authoritative except where this checkpoint records new evidence.

## Open tasks: next action for each

| Task | State | Next action |
| --- | --- | --- |
| G-1275 (rights counter-notices) | Reviewed; two merges refused a spurious unit attribution. `dev-seed-plan.test.ts` passes alone (18 tests, exit 0), but the parser marks its emitted header after the real list-convention failure as another failure. Program owns the parser fix; evidence in `.temp/trust-ops/merge-G-1275.log`. | Retry the complete gate after the fix, with `--allow-scope`. Web edits adapt the case collection to `items` and fixtures; launch was asked to verify its safety view. Migrations are 1442–1444. Refresh immediately after merge, verify rights unit/integration by exit code at the merge commit, then close. Receipt starts the 10–14 business-day window; unconfirmed claimant delivery holds restoration without resetting the clock. |
| G-1294 (security review) | First attempt failed with an engine error, no handoff or commit. Resumed fresh on `codex-1` high. | Review ranked evidence, dispatch each verified High finding to its owner and resume uncovered surfaces if partial. No proof-test-only merge. |
| G-1288 (Zone-page Content authority) | First handoff required `access.agent_provision` for administrator admissions, unlike ordinary `zone.edit`. Returned to Sol (`codex` xhigh) to finish the pinned administrator path; migrations 1650–1651 authorized. | Review and merge the complete register/replay/claim contract, refresh for a migration, verify then send kernel the exact accepted hooks. Preliminary hooks already sent: `withZonePageContentTarget` and `zonePageContentAllowed`. L4 remains the critical path. |
| G-1301 | Sol: route-owned rate-limit families. | Review preservation of current budgets and resolve held-route declarations with their owners. No new registry. |
| G-1302 | Sol: production Account/security/safety preflight. | Review role isolation, real configuration validation and exact missing operator inputs. |
| G-1303 | Sol: offline TDB2 compaction procedure and refusal/recovery tests. | Review actual Jena semantics, disk assumptions, retained recovery generation and explicit retirement. Manager runs the populated timed drill. |
| G-1307 | Sol: production PostgreSQL provisioning/preflight. | Review least privilege, existing owner roles, `pg_read_all_stats` and `max_prepared_transactions=0`. |
| G-1308 | Sol: six-market zero-budget qualification. | Review official source evidence, implemented controls, accepted risk and external conditions; no invented readiness or geographic exclusions. |
| Verification of G-1287 | Preparing `.temp/worktrees/trust-ops-verify`, pinned to `0658a345f`. | Run `platform-governance.integration` and `g-724-bootstrap` and judge exit codes; fix any remaining regression. |

Next local checkpoint follows the next completed handoff or inbox event. Local
implementation and verification need several further waves; deployment
qualification has no defensible completion date until the existing external
operator inputs are supplied. No production action is authorized.

## Contracts and promises to other Goals

- **C1 landed:** e64b08472 (policy in admission, earliest-expiry lease) and
  c3cf4a388 (controller continuity). It is on the program's board.
- **Platform gates landed** at the operation level: ffa8883e4 and bc3f46ec3,
  with contracts in 489786384. The approved matrix is now **525 public and 247
  closed** after G-1239's eight copy and loan operations.
  - Program conditions: no lockout; Account is out of scope; the governance
    seed is part of deployment; the copies read shows only the viewer's own
    copies (launch G-1274 proved it).
  - Template-level gates: kernel **G-1249** (query, graph, export, generic
    edits).
  - `person-schemes` and `third-party-blocks` are closed by construction. The
    duty to gate them when they first appear is in `docs/contracts/api.md`
    ("Platform exposure") and in kernel's GOAL.md.
  - Launch's web hides closed sections from `GET /v1/me/platform-access`
    (launch G-1236).
- **Exposure practice:** new `public` declarations come to trust-ops before
  merge. Inside the first public scope, trust-ops approves them; outside it,
  the program does. Launch also has standing consent to add `read` and `write`
  rate-limit families for its new routes in the same change.
- **Realm creation for launch's G-1238** (merged in G-1250, G-1253, G-1254 and
  G-1261):
  - `AccessRealmManagement.initializeCreated(principal, input, env)`, with
    input `{ realm, actingSubject, creationKey, creationDigest, policyReceipt,
    settings, rules? }`;
  - `initialRealmPolicyFacts(input, space, creationReceiptIri)` returns
    `{ revision, current }`;
  - the permit revision of an initial policy is the creation receipt IRI
    (`rv:realmPolicyHead`).
  - **Open:** ordinary publications still use `urn:rezics:realm-policy:<uuid>`,
    so two revision forms remain, and kernel's `work/select-realm.ts` accepts
    both. Unify them with kernel.
- **Private names** (G-1259 and G-1268, trust-ops part done): kernel's G-1271
  covers export, relations, references, `readName`, search credits and summary
  metadata (media/summary.ts was lent to it). Kernel also plans a Sol task for
  the `PublicNameProjection.java` walk. Launch's G-1269 is done. The call-site
  list is in `.temp/trust-ops/private-name-callsites.md`.
- **Loans granted:** kernel G-1271 may use `media/summary.ts`; launch
  G-1232's `scripts/ops/migrate.ts` merge was allowed on condition that the
  g-722 tests pass at its merge commit.

## Requests routed to other Goals, still open

- **Launch:**
  - The production catalogue bootstrap (`scripts/ops/bootstrap`) must grant
    its principal `platform:use:catalogue-import` before intake.
  - Its verification should run `task ops:platform-governance`.
  - `apps/web/tests/platform-grant.ts` must read `items` and `complete`.
  - IAM01: classify `type:admit` (request it), and `wiki:propose` and
    `quota:reserve` (not requested), in `apps/web/features/auth/scopes.ts`.
  - The Realm queue must collect structured reasons; G-1230 must continue
    notifications after recipient discovery.
  - G-1262: log sites.
- **Kernel:**
  - the content relation-guard references
    (`services/content/tests/online-index-migration.test.ts`);
  - the list convention on the post identifications, projections and
    continuities reads (also sent to the program).

## Follow-ups owned by trust-ops

- Logs: `pg-pool.ts:102,156`, Account `app.ts:72,82`, `address/migrate.ts:43`,
  and two files G-1229 held (`content-projection-worker.ts:24`,
  `rankings/projection.ts:59`).
- Carry each route's rate-limit family beside its `exposure` in
  `openApiOperations`, replacing the separate inventory in
  `rate-limit/routes.ts`. The merge guards (program G-1293) now catch a missing
  family before main.
- Unify the Realm policy revision form (see above).

## Next wave (not started)

- **Qualification exit:**
  - fixes from G-1294's High findings;
  - the six registration and market gates (US, TW, SG, JP, KR, EU) within the
    zero-budget decision.
- **Launch workload budgets:** at the launch catalogue's size, against
  `docs/storage/workload-budgets.md`, with kernel's K5 and launch's L8
  evidence.
- **Privacy-preserving measurement:** logs are done (G-1260). The legal facts
  in `apps/about/src/legal/facts.ts` need the maintainer's deployment
  settings.
- **Deployment preparation:**
  - images;
  - backup and timed restore;
  - the TDB2 compaction procedure;
  - email operations;
  - safety drills and responders.

  `.temp/trust-ops/external-conditions.md` lists 28 external conditions
  (16 block launch). The maintainer was told about the long-lead ones: the
  NCMEC, PhotoDNA and Cloudflare CSAM registrations, SMTP and the hostname
  freeze, the backup responder, the $6 DMCA fee and the Workers plan. No answer
  has been recorded yet.
- **T8, suppression and restore first:** waits for kernel K5 (C6).
- **Inherited items still open from GOAL.md:**
  - TDB2 compaction;
  - batched showcase author proofs;
  - logo-language counting;
  - the production PostgreSQL grants (`pg_read_all_stats`,
    `max_prepared_transactions=0`);
  - long migrations on a populated restore;
  - lock-upgrade and deadlock alerts;
  - migration 1080 in a rolling deploy;
  - the `goal/g-435` salvage.

## Do not miss

- Judge `task goal -- test` by its **exit code and tier table**, never by the
  absence of failure lines; integration runs print no "N pass" lines.
  G-1257 and G-1273 closed unverified that way.
- Merges run the unit gate and 19 repository guards, which refuse only failures
  the task introduced. They also renumber migrations automatically; renumber
  by hand only when a false positive refuses. "Main changed during the unit
  gate" means retry in a short loop.
- After a merge with a migration, run `task dev:refresh -- --wait` and check
  that Main on port 3001 answers ready.
- Workers cannot read the main checkout's `.temp`: stage inputs in
  `.temp/worktrees/<id>/.temp/ref/`.
- Never `pkill -f` with a pattern that also appears in your own command line.
- Modules the AppHost loads must not use `Bun.*`; `task apphost:typecheck`
  checks this.
- Pacing (program): one cap of 24 live workers; no dispatch below 12 GiB
  available; keep a Sol worker on its area across slices (resume it rather
  than dispatching fresh); short briefs.
