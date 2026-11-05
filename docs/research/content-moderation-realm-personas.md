# Moderation disclosure across a Realm ban

This operation binding extends [Content's moderation acceptance](../goals/content.md#acceptance)
and the [moderation Cost map](content-quality-moderation.md#cost-and-growth-map) with
[`moderation-realm-boundaries-http.test.ts`](../../services/kernel/test/content/moderation-realm-boundaries-http.test.ts).
Its private [fixture](../../services/kernel/test/content/support/moderation-realm-boundaries-http-fixture.ts)
uses the unchanged Community native composition: production Access, Auth credentials, mounted Kernel routes,
the registered worker, committed effects and the shared SQL observer. No policy, command result or effect is mocked.

Decision: bind evidence presentation to report reads, exact references to known post/revision GETs, and appeal
presentation to decision reads and board/thread queues; there is no separate evidence or post-appeal GET contract.

## Operations and personas

| Job                                 | Reached route binding and assertion when executed                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Establish an allowed member control | Native Space, protected Realm, scheme, Concept and published board creation; `POST /v1/realms/{id}/members`, registered join completion, then `GET /v1/realms/{id}/members/me`. Both the future banned author and the independent moderator are actual members and read a live post.                                                                                                                                     |
| Submit and inspect a report         | `POST /v1/reports` submits exact thread/post target, revision and evidence. `GET /v1/reports/{id}` and `GET /v1/threads/{id}/reports` or `/v1/posts/{id}/reports` inspect submitted references under current inspection authority. Ordinary protected non-members receive the unknown-target 404 without evidence or identifiers.                                                                                        |
| Present the reported revision       | `GET /v1/posts/{id}/revisions/{revisionId}` reads the known exact revision before takedown. The same exact request is concealed after takedown. Post and revision lists also deny protected non-members and the banned author. No thread-only revision reference is resolved by inventing a post identity.                                                                                                               |
| Take down a thread or reply         | Real `POST /v1/threads/{id}:takeDown` and `/v1/posts/{id}:takeDown`, including same-key replay. Registered completion delivers the author's decision link through `GET /v1/accounts/{id}/notifications`. A surviving thread's post page presents a withheld reply with null body/digest; only its author sees `decisionId`.                                                                                              |
| Ban a current member                | `PUT /v1/realms/{id}/bans/{accountId}`, including same-key replay, returns a non-null workflow ID. The fixture pauses only its own worker before this command. A read-only membership observation confirms removal has not yet published; target reads already deny the original bearer despite a retained independent Realm read grant.                                                                                 |
| Complete removal                    | Restart that same owned worker, await the returned registered workflow and settle committed effects. A second read-only membership observation confirms the interval closed. Repeat disclosure assertions after completion; neither observation performs a transition.                                                                                                                                                   |
| Preserve reporter ownership         | The banned reporter still reads their own submitted report and evidence through account ownership. The live control's `targetAvailability` changes from available to unavailable because of the ban. Same-key report submission cannot replay a target receipt through lost target disclosure. Another reporter's report and target inspection queues remain concealed.                                                  |
| Preserve author appeals             | The banned author reads their decision and submits/replays an appeal through `POST /v1/moderation-decisions/{id}:appeal` while removal is pending. Decision reads expose the pending appeal without decider identity or target body before and after completion. The ordinary non-member cannot read it.                                                                                                                 |
| Preserve moderator authority        | The member moderator and an independently granted platform moderator inspect reports and decisions after the author's ban. After registered projection they read board/thread appeal queues; the original decider has `canResolve: false`, the independent platform reviewer has `true`. The author and ordinary non-member cannot use these queues. No ban is applied to a protected Realm owner/moderator role holder. |

Author-owned decisions and reporter-owned submissions intentionally contain their own retained target references.
Concealment assertions apply to denied target/inspection responses, not these independently owned records.
The live control separates ban disclosure from takedown disclosure. The reply case separates withheld page
presentation from exact reads. Current authority follows [Content](../../services/kernel/src/content/README.md#appeals)
and [Community bans](../../services/kernel/src/community/README.md); the fixture adds no authority rule.

## Existing Cost bindings and execution limits

| Operation                              | Existing three-scale binding, not new observations                                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected Realm reads                  | `realm-boards.test.ts`, 8 / 32 / 128; constant rows/statements at fixed ancestry and logarithmic blocks.                                                                                                                                 |
| Report inspection admission            | `reports-http.test.ts`, 32 / 256 / 2048; constant rows/statements and logarithmic blocks. Selected report pages retain the owning fixed-limit bound and deferred selected-page measurement.                                              |
| Native thread/post takedown and replay | `growth-moderation-native-point.test.ts`, 32 / 256 / 2048; existing same-anchor history, denied/replay work, access-path and shared classifier assertions.                                                                               |
| Appeal queue                           | `appeals-http.test.ts`, 64 / 256 / 1024; existing bounded queue and current target authorization.                                                                                                                                        |
| Ban commands and listing               | Community's `growth-ban.test.ts`, 256 / 1024 / 4096. Durable membership transitions retain the Accounts `realm-membership-transition-growth.ts` binding, 64 / 512 / 4096. This slice does not measure or duplicate ban workflow scaling. |

Setup creates the Realm, member intervals, grants and targets outside persona assertions. Selection is the actual
report/appeal HTTP page. Completion is the registered workflow/effect barrier. Replay uses the original command
key against the same native route. No planner settings, TTL, budgets, page bounds or growth assertions change.
The distinct gap this slice addresses is disclosure during an actual pending ban and after registered removal,
combined with independently owned moderation receipts; existing three-scale samples do not establish those personas.

The binding was authored against clean base `7129bd8d2203ef3afdc2bf398db69442c3044789`, where these files
were absent and the moderation map explicitly excluded actual banned-member coverage. Source presence is not a
reached assertion or a measured pass. The controller's frozen command is:

```sh
bun run --cwd services/kernel check test/content/moderation-realm-boundaries-http.test.ts
```

The admitted runner must bind its result to the exact source revision and report the reached assertion or failure.
Three-scale measured values come only from their existing owning runs; none are generated by this persona slice.
Full acceptance, browser launches and growth reruns remain deferred to controller integration. A missing route or
implementation failure must name the reached native request and owning seam; it cannot be converted into a pass
by fixture SQL, a direct effect call, a new API or a relaxed assertion.
