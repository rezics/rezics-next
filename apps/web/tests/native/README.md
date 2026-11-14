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

Run the existing Auth/native-stack witness after coherent source and generated-client publication:

```sh
bun apps/web/scripts/check.ts --host tests/native/hosted-book-journey.host.test.ts
```

The private author journal saves actual English and French chapter bodies through mounted Studio. It retains
saved-version comparison and preview, deterministic cover upload, nested parts, root append, reorder and move.
The existing language-association form separately grants exact Book-scoped source consent and binds the canonical
English default plus the French alternative, without publishing either standalone Post. Native draft-language
readback checks their selected titles and Post/revision/digest tuples.

One selected occurrence enters the existing bounded preparation, including its language alternatives. Reload keeps
the stage locator, excluded chapter and source-head assertions. Mounted authority checks and explicit activation
must produce the initial release. Only then do later private body edits and draft moves establish that the frozen
release remains unchanged. Anonymous native byte reads and actual reader controls prove the French title/body,
Automatic, unchanged interface locale, exact links, and browser Back/Forward. Another member saves and resumes the
French checkpoint and follows Library Continue; its stored exact body/language remains French while English opens
without reusing that block position.

The prepublished control retains its independent point consent/publication, original chapter, supplied catalogue
title, checkpoint, old-link-after-move and withdrawal assertions. It cannot replace the private author's activation
or language outcomes. Every required failed or unreached journal stage fails the suite. Source presence, an
illustrative fixture or a passing independent control is not acceptance of the author journey.

The fixture owns one native/Auth stack and resource cleanup. No additional seed, publisher, stack or permission
bootstrap replaces a mounted body-publication result. Record source revision, actual journals and reached failures
separately from source integration and promotion. Current source exercises the parity floor from read-only
`../rezics` at `95167ceab7173dc1c5fb0ee70568c5c95f1dba8d`; frozen multi-language selection and stable exact links are
improvement claims only after the corresponding native/browser stages execute successfully.

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
