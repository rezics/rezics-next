# State

Checkpoint `checkpoint:1b1e81f3-be9e-494f-afcf-1a0e54f7c4d4`, 2026-10-13 13:01 UTC, for [API](GOAL.md). Consolidates the seven handled events below; their product decisions remain in their briefs. Concurrent turns own subsequent decisions.

| Measure | Snapshot from `task goal -- status` |
| --- | --- |
| Rows proved / scope | **22/67**; **170 proved, 112 pending, 0 not applicable, 120 missing** cells |
| First-attempt share | **69%**, today **33/48**; 33 first attempts, 18 step resumes, 15 fixes; no capacity or transport retries. Seven fixes inferred from unavailable handoffs |
| Attempts per landed task | Median **2**, maximum **3** (G-2106) |
| Tokens per proved row | Tool reports unavailable. API totals: **348.1M input, 1.6M output**; no comparable proved-row population supplied, so no derived ratio |
| Findings that blocked | Retained refusal counts: 0 outcome, 2 gate, 0 failing-test finding, 2 other. Preparation/quota refusals remain distinct from demonstrated delivery failures |
| Live / open API tasks | **9 / 16** at this snapshot |
| Checkpoint decision | Carry forward the handled decisions and their holds. First-attempt share and landing median meet the method's thresholds; this event authorizes no dispatch, resume or landing retry |

The last recorded efficiency audit (`task goal -- efficiency --last --json`) is dated 12:35 UTC and covers 09:30–12:35 across Goals: 378,496,608 input tokens, 368,999,040 cached (97%), 51% no-decision share and 156,268,593 input tokens attributed to waits. It is historical, not an API tokens-per-row measure or a new dispatch order. Program owns the audit. No watcher or worker wait is started here.

| Handled event | Decision carried forward |
| --- | --- |
| `mail:035ac9a4-ec07-4134-9da8-eace450f6ef9` | G-2141 repairs four published Recipe peer-read cells; G-2142 reserves the Zone saved-draft editor repair; G-2143 reserves exact Zone publication mandate selection. G-2134 was dispatched by Program; leave it with its owner. Decision `f4fad8915` |
| `task:G-2139:1` | Supersede the creation-authority diagnosis with quota-aware outcome preparation. Preserve the three-Spaces-per-account monthly baseline; prove founding with remaining capacity, refusal at exhaustion and successful-intent replay. Decision `2657a21fd` |
| `task:G-2141:1` | Approve bounded `canPreviewWork` through the existing Access owner and additional claims. Public reads retain the published pin; preview requires current explicit private-read authority, with existing recovery, policy, identity and lifetime fences. Decision `95ee79551` |
| `mail:52279abb-e57a-42e7-9ded-154dbfdc8964` | Separate Realm population prerequisites (G-2146), boards outcomes (G-2147), qualified same-Person import repair (G-2148), sourced Recipe prerequisites (G-2150) and published Recipe reading (G-2151). G-2111 retains sourced publication implementation ownership. Decision `1959d87be`; G-2147's later Program-read recut is authoritative |
| `mail:d182eadd-6cc8-4fb5-841d-20875ee6883c` | G-2148 may claim `apply.ts` for identity reuse at empty-shelf and membership sites; ownership is Person-scoped, never name matching or another Person's shelf. Decision `a20105d66` |
| `mail:710e6af7-4e87-44b2-a3df-fbf582789938` | G-2148 may also claim `composition.ts` for optional Fuseki dependency wiring and bounded exact-ID/curator lookup. Read access is not ownership; unavailable evidence preserves dependency failure. Decision `2877e9f5b` |
| `mail:5c62607e-fbed-4ff0-92c7-86ef9b752a25` | G-2153 qualifies twelve regression candidates through current public persona requests, Books first. G-2155–G-2157 hold obsolete-test cleanup behind outcome work. Source-overlap references add no acceptance cells. Decisions `9b48ec584`, `ea278507b` |

All five listed mail deliveries were already acknowledged: 12:28:52, 12:50:36, 12:54:09, 12:57:08 and 12:58:05 UTC respectively for mail 035ac9a4, 52279abb, d182eadd, 710e6af7 and 5c62607e. Acknowledgement is idempotent; task exits are handled through their brief decisions, not Goal mail.

| Work | Position and next action |
| --- | --- |
| G-2139 | Exited outcome task; owner stays pending. Use fresh principals that actually own a Realm, with remaining account capacity and two free slots for the concurrent handle race. Preserve six persona outcomes, private settings, replay, enrolment and one-winner resolution; prove exhaustion and replay over public HTTP. No product authority defect established; its handled event resumes no worker |
| G-2141 | Attempt 2 exited; reviewer exited 1 in the fresh ledger. Its subsequent handoff/review event owns the landing decision. Preserve unchanged authoring/exchange HTTP assertions and complete private-preview negative controls; the earlier baseline proves no repair |
| G-2142 | Held saved-home editor repair: use the distinct resolved home identity consistently in the hydration fence; actual mid-read movement must still fail safely. Prove the owner's whole cell while public home retains the previous published document |
| G-2143 | Held exact-resource mandate repair, distinct from governance publication. Exact live proof must not be shadowed by wildcard ordering; wildcard-only foreign access stays refused. Preserve scope, lifetime, recovery, replay and author credit; one authority review |
| G-2146 | Held behind G-2138's `personas.ts` claim, with Program's loan recorded. Reach complete ranking/discussion populations using live public sessions before classifying residual failures; preserve populations, cursor scope and admission history |
| G-2147 | Running outcome task. Program's recut defines boards as classification Concepts/entity references on Realm placements, with at most one primary, using existing classification/facet/discussion operations. No independent board resource, owner or permission list. Prove six personas; exact unsupported requests return for a minimal contract decision |
| G-2148 | Running implementation after G-2135 qualified same-Person reimport: 34/34 rows, zero issues, shelves 2→4 and memberships 1→2. Preserve owned portable IDs, fresh-Person restoration and all eighteen HTTP cells. Exact ownership lookup serves both reuse sites; authenticated commands own writes. One authority/disclosure review |
| G-2150 / G-2111 | G-2150 running outcome prerequisites; G-2111 code held until complete Source, public-domain basis, author credit, transcriber, Structure and exact-mandate controls yield a bounded settled claim. Current 400 schema rejection proves neither Source binding nor reader delivery |
| G-2151 | Held behind G-2141's overlapping claims. Verify its repair first; fix only residual published-revision selection/scaling/traversal, or promote the five pending cells if every unchanged assertion passes. Owner public reading uses the published pin; explicit composition preview remains available |
| G-2153 | Running read-only qualification: D007, D018, D040, D048 first, then D005, D028, D034, D049, D052, D082, D102, D112. Confirmed failures need an independent outcome test before implementation. Unconfirmed or unreachable prerequisites do not reopen proved cells |
| G-2155 / G-2156 / G-2157 | Held obsolete-promise cleanup: D001, D004 and the nine remaining groups, tests/fixtures only. Dispatch only when no outcome row awaits a brief or worker, capacity and claims permit, and required area loans exist |

Regression refs on G-2141 (D063/D085/D098/D104), G-2143 (D063/D091) and G-2151 (D098) are source overlaps, not additional tasks or acceptance cells. Remove a later-list entry only with a passing referenced test or a named current outcome replacement. The 89 deferred causes receive no independent task. Old regression results, empty inventories, unrelated missing answers and failed setup are not current failing cells.

Earlier decisions remain in force: G-2076/G-2077, G-2133 and G-2135 are landed and archived; leave them closed. G-2134's continuation repair was dispatched by Program, superseding its hold. G-2138 is now exited; its next event owns closure authority implementation and subsequent delivery qualification. Preserve the proved visitor notification cell and distinguish unreachable closure from post-closure leakage. G-2074 remains merged/open at its three-attempt cap, with the retained backup boundary split and no ordinary row gated. G-2078, G-2096–G-2098 and G-2108 remain running outcome work in the snapshot; their events own their next decisions.

G-2109 ancestry waits for prerequisite outcomes before one shared owner and whole caller set. G-2110 typeahead waits for a compatible retained set and the exact logged query at two scales; eighteen reads is not established (23 observed, 72 allowed). Preserve implementation assertions; disputed expectations return to the manager. Start remains resumed under GOAL.md; the old 06:03 pause is historical. The prior checkpoint is `540bcd7d7:docs/goals/api/state.md`, and the longer historical inventory is `f695ff57e:docs/goals/api/state.md`. Briefs are named by ID because they leave the tree on closure.
