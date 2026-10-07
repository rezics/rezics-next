# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`. Taken over on 2026-10-07 by GPT-6.1 Sol in tmux
`goal-trust-ops`, registered as `goal-trust-ops-codex`. Program manager:
`rezics-next-7b`. The prior handover's contracts and remaining inventory below
remain authoritative except where this checkpoint records new evidence.

## Current checkpoint

**Refresh hold (maintainer and program, 2026-10-07):** run no `dev:refresh`
until kernel reports the shared stack healthy. The first rights refresh failed
because Statement upgrade called the intentionally absent raw `/update` route.
Kernel's native repair owns all shared lifecycle actions and will apply Access
1650. The second trust-ops refresh had exited before queuing or lifecycle work;
no trust-ops refresh remains queued/running.

Closed and verified since takeover:

- Rights counter-notice `03ad5168e714`: receipt clock, confirmed claimant
  delivery gate, party privacy, bounded case records. Owner and integration
  passed at that merge SHA after pinned OpenAPI regeneration.
- Zone Content authority `0e5218da741d`: server-resolved Zone, no-provision
  administrator path, immutable Zone/grant/controller proof at replay/claim.
  Kernel has `withZonePageContentTarget` and `zonePageContentAllowed`; focused
  real owner verification passed. Access migration 1650 awaits shared repair.
- PostgreSQL preflight `cacbd6b2e`: diagnostic grants and zero prepared
  transactions; focused owner/integration passed at the merge SHA.
- Market decision record `57e4c55d74d8`: six conditional launch markets,
  external facts and accepted risks explicit; focused registration/docs passed.
- Offline compaction `8c01f7bbd`: retained recovery generation, bounded disk
  preflight, rollback and explicit retirement; shell/operator tests passed.
  Populated 100k timed/peak-space drill remains manager work after repair/C6.
- Security H1 `96bf4db360df`: every recovery enrollment uses normal bounded
  password+TOTP/passkey step-up; real first/spent/session/expiry tests and UI
  evidence. Security H2 `1154b205ebc7`: checked public destinations/socket
  pinning and edit authority before acquisition and storage. Medium media
  intake `3957f02adb3a`: live bearer/reservation before bounded stream/deadline.
- H4 Account contract `07ac9df29782`: `library:write` registry/resource/consent
  support with complete eight-locale meaning and rendered consent evidence.
  Launch G-1314 owns route/client enforcement; H4 remains open until it lands.
- Inherited bootstrap/governance checks both passed at pinned `0658a345f`.

The findings-only security review is archived; its report is preserved in
`.temp/trust-ops/security-findings.md`. Closing that review did not qualify the
open findings. Every completed code task passed its merge's unit/guard gate;
focused worker checks are recorded in handoffs, with targeted merge-SHA checks
above for the inherited verification gaps.

| Task | State / next action |
| --- | --- |
| G-1301 | Resolver consolidation reviewed, blocked until held route declarations are all present. Manager's 109 kernel metadata declarations landed in `6b4504057` with kernel consent; worker has rights/reports and released routes. Launch still owns Zone/thread metadata. Resume on current main, prove complete coverage, then merge with reviewed route scope. No fallback inventory. |
| G-1312 | H3 backchannel logout: reviewed complete five-boundary rejection and legacy dispatch suppression; merge gate running. Close on pass, notify program. Bulk multi-session revocation snapshot follow-up remains to brief. |
| G-1316 | False Terms automatic-image-hold promise corrected at `a3001325ab0f`, new Terms digest requires current acceptance. Closing. Its About config failures are assigned below. |
| G-1309 | Sol: private database/alias diagnostics via existing safe logger; Account app is now released by H1. |
| G-1318 | Sol: production email TLS, signed delivery events and sender-domain evidence using local fakes; no external mail. |
| G-1319 | Sol: portable production validation imports and default Accounts Storybook config. About failure was introduced/exposed by preflight's heavy Main import; retain actual validation. No temporary-config-only acceptance. |
| G-1320 | Sol: second outbound destination-filter instance, MCP expanded/special IPv6 forms. No generic transport framework. |

Launch's public `POST /v1/zones/{id}/site-publications` exposure/write family is
approved within the first Zone scope. Launch's moderation preset notice review
needs truthful release durations (author fixes/withdrawal do not alone restore),
case-specific public facts and accurate automation indication; no new reason-code
contract was requested. Program's local-QA-only recovery memory wrappers are
accepted if production behavior is strictly unchanged.

Next local checkpoint follows the next handoff/inbox event. Deployment
qualification needs further implementation/drill waves and the already listed
external operator facts/registrations; no defensible final date can be stated
until those inputs are supplied. No production action is authorized.

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
