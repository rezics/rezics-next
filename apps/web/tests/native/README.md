# Native web acceptance

## Knowledge first-public journey

The mounted native witness is `tests/native/knowledge-journey.host.test.ts`, prepared by
`tests/native/knowledge-journey-fixture.ts`. An author creates a private notebook with a nested
document, saves two distinguishable revisions, publishes the exact saved revision, and later private
edits leave public reading frozen on that selection. An anonymous reader and another native member
see only disclosed public text. Reuse copies the selected public revision into a second owned
notebook. Kernel readback is independent of the page. Content native first-loop and focused
private/publication/transfer tests remain the source owners.

Controller invocation after integration:

```
bun apps/web/scripts/check.ts --host tests/native/knowledge-journey.host.test.ts
```

Native/browser execution is controller-owned. This fixture does not establish full Knowledge
lifecycle acceptance, all-locale/theme visual quality, main promotion or release.

## Publication scenarios

The wrapper registered all 28 scenarios. Twenty-six currently fail during fixture setup: `settle()` cannot find three
fixture titles in `/v1/subjects:search` before the outcome suite's 180 second hook deadline. The remaining two stop
earlier when fixture writes receive HTTP 503 `deadline_exceeded`. These are waiting on Search API indexing and kernel
write availability, respectively. `vite.config.ts` now runs localization generation in a Bun subprocess so the native
Vite Worker can start. A test that needs a driver control not yet present is also marked as waiting for its driver task.

| Scenario                                                                                                                            | Status  | First failure line                                                                | Waits for                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| subject-traversal: editions are reachable once in declared order across full pages                                                  | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| subject-traversal: contents are reachable once in declared order across full pages                                                  | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| subject-traversal: cast is reachable once in declared order across full pages                                                       | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| subject-traversal: crew is reachable once in declared order across full pages                                                       | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| subject-traversal: inverse credits are reachable once in declared order across full pages                                           | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| subject-traversal: relations are reachable once in declared order across full pages                                                 | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| subject-traversal: credit character credited name position and spoiler retain their meaning                                         | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| subject-traversal: Details reaches competing sourced date and editorial history                                                     | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API indexing; driver task for `proposeCompetingDate`     |
| published-vertical-metadata: Book publishes author word count light-novel form and harem tag                                        | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| published-vertical-metadata: Recipe publishes instructions diet and PT25M cook time                                                 | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| published-vertical-metadata: game metadata agrees with the rendered work                                                            | Failing | `Could not create fixture subject cast-074: API status 503 deadline_exceeded`     | Kernel API: accept fixture writes within their request deadline |
| published-vertical-metadata: release metadata preserves release identity and facts                                                  | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| published-vertical-metadata: person metadata agrees with the rendered person                                                        | Failing | `Could not create fixture subject editions-046: API status 503 deadline_exceeded` | Kernel API: accept fixture writes within their request deadline |
| published-vertical-metadata: organization metadata agrees with the rendered organization                                            | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| published-vertical-metadata: automated account metadata agrees with the rendered agent                                              | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| published-vertical-metadata: withheld facts are absent from HTML and JSON-LD                                                        | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| published-vertical-metadata: stale slug redirects to the canonical localized slug                                                   | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| published-vertical-metadata: verified agent subject redirects to its handle page                                                    | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| published-vertical-metadata: configured alternate public origin is canonical                                                        | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| public-discovery-and-cache: robots and every sitemap shard publish exactly eligible native feed URLs                                | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| public-discovery-and-cache: Alice warming a public page cannot leak personal facts to anonymous or Bob                              | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| public-discovery-and-cache: private hydration requires Alice current authority                                                      | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API indexing; driver task for `revokeAlice`              |
| page-states: preparing subject view is useful retryable and does not cache an error                                                 | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API indexing; driver task for `interrupt`                |
| page-states: unavailable owner read serves an unavailable page with Retry-After                                                     | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API indexing; driver task for `interrupt`                |
| page-states: private Collection is indistinguishable from missing to anonymous                                                      | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| page-states: empty public list explicitly says it is empty                                                                          | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| page-states: native suspended persona personal read is 401 invalid_credentials with invalid_token challenge and no personal content | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API: index the fixture's three matching titles           |
| search-page: anonymous zh-Hans Book search renders native order localized unique facets and no engine totals                        | Failing | `beforeEach/afterEach hook timed out for this test`                               | Search API indexing; driver task for `nativeSearch`             |

## Hosted Book author-to-reader journey

Decision: keep the private author and prepublished reader journals independent; compare and preview saved revisions,
organize and select exact draft occurrences through mounted Studio, recover and seal the selected candidate, record
initial activation as unreached with its immutable operands, and use supplied catalogue titles with the existing
fallback.

Run the mounted witness with:

```sh
bun run --cwd apps/web test tests/native/hosted-book-journey.host.test.ts
```

The private author journal saves two private chapter revisions and a deterministic cover in Studio, previews and
compares the first chapter's saved revisions, creates a part, root-appends and reorders the second chapter, then moves
it under that part. It selects one exact root occurrence in private release preparation, reloads by the retained stage
ID, freezes that selection and seals the candidate. The journal records the immutable owner, draft, stage, occurrence
and Post/revision/digest operands. The mounted initial-publication producer
`activateHostedPublicationCandidate` has no HTTP route or generated KernelClient operation, so activation, anonymous
author-release bytes, author discovery, progress and its old reader link are explicitly unreached. Later private
editing and moving must leave the draft occurrence pinned to the selected saved revision.

The independent control starts from a generated native one-chapter public release. Studio saves a newer exact private
source revision, adds a draft occurrence, issues permission in point review, and explicitly publishes that exact
occurrence. The journal checks permission does not publish, reads the anonymous exact bytes, and confirms direct Post
privacy. Another member discovers the Book using its supplied title (with the existing numbered fallback), opens the
original chapter, saves and resumes a Library checkpoint, then follows its old release/occurrence URL after a later
move and withdrawal. The control does not satisfy the private author's initial activation stage.

Legacy parity comparison: `legacy-final` at `95167ceab7173dc1c5fb0ee70568c5c95f1dba8d` already had chapter revision
history and comparison, ordered nested contents, and reader progress/resume. This fixture exercises those behaviors
through current mounted controls. Current canonical reader links also carry explicit frozen release and occurrence
coordinates; the control's old-link-after-move stage checks that addition. These are source assertions only until the
controller runs the native witness.

The focused native command is:

```sh
bun run --cwd apps/web test tests/native/hosted-book-journey.host.test.ts
```

The source worker does not start a stack or run this command. The candidate controller runs it once after integration
and records the private-author and control journals separately. A passing control is not a passing author release;
only a reached mounted initial activation followed by exact anonymous bytes, member progress/continue and stable old
link completes the private author outcome.

The required private-author stages are `save chapter one and upload the deterministic original cover in Studio`,
`preview the saved chapter privately through the mounted Studio view`, `compare the original and current saved chapter
revisions in Studio`, `save chapter two as a separate private exact draft in Studio`, `anonymous direct reads conceal
private chapter drafts before release`, `start the private Book from the saved opening in Studio`, `create a part
through the Book Studio outline`, `append the second saved draft at Book root through the mounted Root Append route`,
`reorder the appended root chapter before its part in Book Studio`, `move the reordered exact placement into its part
in Book Studio`, `review, recover, and seal the exact selected private candidate`, `save a later private chapter
revision after candidate sealing`, and `move the selected source placement after the sealed candidate`. The initial
activation and private-author reader stages must reach a mounted release receipt, exact anonymous bytes, discovery,
progress/continue, and a stable old link before author acceptance; an `unreached` producer boundary is not a pass.

The independent control must separately reach `permit the exact private version, then publish that selected occurrence
through point review`, `member opens the control through current Book subject discovery`, `member saves and resumes the
exact hosted chapter through the Library checkpoint`, `move the control placement after publication through Book
Studio`, and `the emitted old reader URL still serves its exact release after a later move` (the journal also records
the post-move withdrawal readback). It does not substitute for any private-author stage.

## Book catalogue discovery and shelves

Fixture source revision: `d4e0b8ee26760c93f7456d866e4ef54c884850d7`.

Focused command:

```sh
cd apps/web && bun scripts/focused.ts --private-network -- bun test tests/native/book-catalogue-journey.host.test.ts
```

Evidence status: the worker authored the native fixture and mounted journey but did not execute it. No browser or
native outcome is claimed here. The controller must run this command on a containing candidate and record the
fixture's actual Search identities, localized Books and type-filtered visits, literary reader identities, shelf
command, independent Library readback, sign-in return and public authorization boundary. This record is separate
from the existing Studio publication scenarios above.
