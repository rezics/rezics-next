# Web and UI check entrypoints

This document owns Web/UI launcher placement and its bounded coverage. It supersedes the older local-focused and
local-fallback descriptions in the app README. Performance owns shared classification, check-host admission,
`scripts/check-run.ts`, remote execution, preparation, authenticated receipts, cancellation and artifact transport.
The verifier retains its existing admission and publication authority. Web does not create a broker or a verifier API.

## Finite execution

`scripts/check-placement.ts` is the Web receiving adapter. Every finite route below enters it before native heavy
work. The default native continuation requires an actual, realpath-resolved workspace and cwd confined beneath the
existing remote-check run root. Caller remote markers, local/off switches, memory/stack leases and historical weights
cannot admit native work on a worker. Missing producer source, missing hosts and failed transport fail closed; there
is no local replay. The sole opt-in exception is ordinary Storybook publication validation with `--local`, bounded
to its exact clean committed snapshot and the finite deployment validation commands below. Unknown focused commands
also go remote. Workspace typecheck scripts remain direct compiler routes; this slice adds no competing small-unit
classifier.

The adapter invokes the agreed Performance CLI with individual argv tokens:

```text
bun <trusted-root>/scripts/check-run.ts --hosts <absolute-hosts-json> --workspace <absolute-candidate-root> --cwd <workspace-relative-directory> --source-revision <full-candidate-commit> --env-file <absolute-environment-json> [--returns <workspace-relative-path>]... -- <original-argv...>
```

The default trusted root is the main checkout discovered through Git's common directory; a caller may select a
separate snapshot with `WEB_CHECK_DRIVER_ROOT`. Selection captures `refs/heads/dev` once from the candidate's common
Git directory. The chosen driver must be a separate physical checkout in that same common repository, and its full
HEAD must be an ancestor of the captured dev commit. The main checkout may lag behind dev; its current HEAD is not
the integration authority. A missing dev ref, foreign repository, unintegrated snapshot, changed or untracked source
in the driver's imported closure, or imported bytes differing from their committed versions is unavailable before
spawning. Unrelated checkout entries do not affect this source-integrity check. The driver root must differ from the
candidate root; a candidate cannot select its own newly committed driver. This is a source-integrity guard, not
verifier admission or a release receipt.
The candidate revision comes from the candidate's Git identity, independently of the driver root. Performance must
freeze/verify exact candidate inputs, native Git identity and same-snapshot generated Web inputs, and use its pinned
Bun/frozen dependency preparation. Absent or unsupported producer source is unavailable, never an installed receipt.

A private per-invocation environment JSON lives outside candidate source and is removed after the driver settles.
Semantic strings and newlines survive JSON; argv is never joined into shell text. Inherited Node, npm, nvm,
desktop/debug settings and host-absolute paths are omitted; explicitly requested unsupported host-local settings and
host-absolute environment assignments are refused. Web omits every inherited `KERNEL_CHECK_` variable, including
`KERNEL_CHECK_AFFECTED`. Direct kernel `--affected` and an intentionally supplied driver `--env-file` may still
select affected tests. Host runtime/cache settings, Goal/session credentials, publication credentials and placement bypass
controls are excluded from the native overlay.
`STORYBOOK_OUTPUT_DIR`, `GROWTH_PROFILE`, `WEB_TEST_STATE_DIR` and `WEB_CHECK_EVENTS` are explicitly relocated from
contained workspace paths relative to the native cwd. Growth profiles, named test state and event outputs are also
declared returns. Treat only the ambient `NIX_SSL_CERT_FILE` as a host-only Nix toolchain setting: omit it from the
native semantic overlay without opening the path or transferring the local path/certificate, and leave the caller's
environment unchanged. The remote host uses its own trust configuration. Other host-absolute file settings,
host-absolute argv dependencies and paths escaping through symlinks are unavailable. These restrictions are
diagnostics, not permission to drop required semantics.

The local driver process inherits its receipt fd 3 and nonce, signal/cancellation controls and stdout/stderr.
The native environment overlay does not inherit receipt authority. INT/TERM/HUP and an invocation AbortSignal reach
that driver. The driver owns queued cancellation, physical cleanup and confirmed terminality; it must retain unknown
remote custody and source snapshots. Web does not release that custody, delete the remote snapshot or manufacture
receipts from logs/exit codes. Native status, timeout 124 and transport 75 pass back unchanged. Errors from private
environment cleanup retain the command/transport failure as well.

## Routes and returned artifacts

| Entry                                                                 | Physical command / behavior                                                                                                                            | Returns to the caller                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Web `build`                                                           | Original `vite build --config vite.config.ts`                                                                                                          | `apps/web/dist`, `apps/web/.wrangler`                                                                |
| Web `check`, `test:stories`, `test:host`, explicit host/browser modes | Original check argv and native test selection; preparation occurs remotely before tests                                                                | Timing cache; explicit browser report directory; prepare-only template `.dev.vars`                   |
| Web `test`                                                            | Original isolated wrapper and its Bun test argv                                                                                                        | Declared named state/profile/event paths; otherwise no persistent result tree                        |
| `focused.ts`                                                          | Original command after remote message/route preparation; optional private network, output relay and independent process-group/fixture cleanup retained | Declared named state/profile/event paths                                                             |
| `storybook-build.ts`                                                  | Both original Web and UI Storybook builds in the same physical run                                                                                     | Entire selected output tree, including `ui/`, compatibility indexes and exact candidate `build.json` |
| `storybook-deploy.ts`                                                 | Remote validation by default; explicit `--local` uses the same finite build and unchanged six smoke scenarios before local publication                 | Entire validated Storybook output tree                                                               |
| `storybook-smoke.ts`                                                  | Same six selectors and render/image/language/cover assertions, on existing artifacts in that physical snapshot                                         | No new artifact tree                                                                                 |
| `screenshots.ts`                                                      | Original capture selectors, locales, themes and widths, then build/browser capture remotely                                                            | Exact contained `--out` tree; default `.temp/screenshots`                                            |
| `cards.ts`                                                            | Original browser card rendering                                                                                                                        | `apps/web/public/cards`                                                                              |
| UI `test`, `test:stories:slow-frames`, direct UI `isolated.ts`        | Original command after placement and before network probing or child spawn                                                                             | Declared named state/profile/event paths; no implicit temp fixture returns                           |
| UI `check`                                                            | Existing formatting/compiler steps, then routed test command                                                                                           | Same as UI test                                                                                      |

The screenshots output argument is relocated in place, preserving the order of all flags. A destination outside the
candidate is refused before capture. Build outputs likewise must be contained. Artifact transport must copy only
outputs of this physical run, including on failure, and retain native failure plus return/cleanup failure. Web adds
no competing artifact copier. The complete composed Storybook tree must return before remote removal, not just Web's
index. The UI scratch build cleanup and the exact Git-derived build metadata remain native build behavior.

`runWebTestLanes` and `runBrowserWorker` are receiving workers and refuse direct local calls. A supplied browser in
`smokeStorybook` is usable only under actual physical run custody; an in-memory browser cannot cross placement.
The caller continues owning a supplied browser. An owned browser and static server are independently cleaned up;
setup errors are detected before browser launch and primary/cleanup failures remain visible.
In-process focused preparation/start/output hooks cannot be serialized through the finite CLI. They are supported
only under actual remote custody; a local programmatic caller receives unavailable before any preparation or spawn.

## Validation and native publication

`storybook-deploy.ts --validate-only` is a finite build-and-smoke command with no upload or publication branch.
The ordinary deployment command accepts this explicit local validation option:

```sh
bun run --cwd apps/web storybook:deploy --local
```

Without `--local`, validation keeps its default remote placement. With it, the deploy entrypoint labels validation as
local, requires a full commit SHA and a clean tree, and passes that exact revision to check-placement. Check-placement
admits only `storybook-deploy.ts --validate-only`, `storybook-build.ts` with no extra arguments, and
`storybook-smoke.ts` with no extra arguments from `apps/web`; each local continuation rechecks the revision and
clean tree. The build and the same six smoke scenarios run unchanged. This narrow grant does not admit interactive
servers or other heavy commands, create remote custody or receipts, or alter the separate remote receiver and
prepare/register work. `--local` cannot be combined with `--validate-only` or `--status`.

`runDeployment` retains its clean-tree check and unchanged same-commit/force cadence before validation. For the local
option it checks the same committed snapshot again after validation, then removes local leftover Cloudflare output,
performs dry-run or upload/deploy/triggers through the native local Wrangler runner, and requires live `build.json`
equality. The existing build/smoke callback contract remains usable; the CLI uses the finite combined validation
callback. No other workflow or publication authorization changes.

Standalone smoke does not implicitly transfer a previous ignored local build. The finite CLI has no agreed input-
artifact option. When its physical snapshot has no built Web/UI indexes, it reports unavailable before launching a
browser. Use finite validation for a source-derived build and smoke together; an independently supplied prepared
artifact/input identity remains a Performance interface gap. Do not invent an input flag or use stale local output.

## Interactive access

Storybook `dev` on ports 6006/6007 is explicitly unavailable. The finite remote CLI does not provide a supported
access/tunnel API or durable long-running interactive custody. No environment marker enables a local listener.
Web `dev` is also unavailable for standalone interactive use. Its original Vite command is admitted only as a
finite check's test-runtime child inside an actual remote run; test-runtime environment alone is insufficient.
Those finite fixtures retain their existing independent server/browser cleanup and no tunnel API is implied.

## Receiving obligations and remaining coverage

`check-placement.test.ts` authors pure mocked placement, argv/environment/returns, native/transport failure,
cleanup aggregation, cancellation and callable/supplied-browser regressions. It starts no browser/build/server.
This source slice does not supply physical proof. The original native acceptance, six-smoke execution, artifact
round trips, authenticated receipts and cancellation/unknown-terminality cases require normal integration receiving.
No claim of runtime release, all-launcher closure, or whole-Goal completion follows from compiler success.

The integrated producer CLI, prepared-input/return verification and physical host admission remain Performance/CP
receiving obligations. The verifier's durable pre-spawn acquire/bind/release interface is not the existing post-spawn
ProcessCustody helper; this slice neither invents that ABI nor changes its consumers.
Direct `apps/web/scripts/isolated.ts` and shared `stack-run.ts` receiving remain Performance-owned: their historical
fallback is not repaired by changing Web's package wrapper. This slice guards the Web package route and its own
check/browser workers, and makes no claim that a direct invocation of that other owner's isolated script is closed.

Direct test launchers still need sequential receiving work under Web ownership. Package placement protects a test
started through these packages, but a raw `bun test <file>` can reach a direct launcher without visiting a package
wrapper. Guard/route at the owning test's entry before fixture creation, not only after starting its fake server or
creating an ignored temporary story. Preserve exact native argv/assertions and independent safety cleanup. In
particular:

- `tests/support/dev-server.ts` needs its physical-custody guard before the first server spawn; Vite-caller tests
  need receiving at their fixture entry, including callers that start fake API listeners first.
- Raw Storybook tests need receiving before scratch-tree generation and direct Storybook/browser launch. Existing
  post-spawn custody and cleanup helpers remain responsible for independent fixture settlement.
- Raw Vitest wrappers need receiving before writing probe stories/reports. UI tests already invoking `isolated.ts`
  reach its new guard, but transport of a caller-created host-absolute report or probe is not implicitly supported.
- Native stack/private-browser and public-render/pages-worker fixtures need their own supported physical placement
  and admission, before their first listener/container/browser spawn. This slice changes no native fixture file.
- Bounded mock/compiler/helper fixtures in the inventory need positive shared classification, not a blanket browser
  label. Neither an import match nor the historical inventory establishes heavy work or proves closure.

The following current-source API sites extend the prior 134-file receiving inventory. Line numbers are insertion
seams for follow-through, not new frozen tests or executed evidence. Categories come from that receiving inventory;
`inspect` marks additional/unclassified sites, including embedded fixture source. All rows remain audit work unless
an owning wrapper above is actually on their invocation path.

| Source                                                       | Process/browser/listener API lines                      | Receiving category                 |
| ------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------- |
| `apps/web/tests/agent-handle-forwarding.test.ts`             | 33, 66, 88                                              | vite-dev-preview                   |
| `apps/web/tests/anonymous-reads.test.ts`                     | 64, 129, 173, 207                                       | vite-dev-preview                   |
| `apps/web/tests/auth-binding.host.test.ts`                   | 50, 133                                                 | inspect                            |
| `apps/web/tests/board-realm-crumb.test.ts`                   | 107, 178, 194, 227                                      | vite-dev-preview                   |
| `apps/web/tests/board-sort.test.ts`                          | 69, 120, 140, 174                                       | vite-dev-preview                   |
| `apps/web/tests/bottom-sheets.test.ts`                       | 54, 120, 139, 174                                       | vite-dev-preview                   |
| `apps/web/tests/bylines.test.ts`                             | 139, 188, 204, 237                                      | vite-dev-preview                   |
| `apps/web/tests/catalogue-language-row-recovery.test.ts`     | 13                                                      | vitest-indirect                    |
| `apps/web/tests/check-fresh.host.test.ts`                    | 12, 25                                                  | inspect                            |
| `apps/web/tests/checkout-cost.test.ts`                       | 129, 280, 295                                           | vite-dev-preview                   |
| `apps/web/tests/checkout.test.ts`                            | 234, 354, 374, 443                                      | vite-dev-preview                   |
| `apps/web/tests/closed-controls.test.ts`                     | 59, 189, 225, 294, 441                                  | vite-dev-preview                   |
| `apps/web/tests/collection-boundary-move.test.ts`            | 204                                                     | inspect                            |
| `apps/web/tests/collection-member-editor-journey.test.ts`    | 157                                                     | inspect                            |
| `apps/web/tests/composer-media.test.ts`                      | 205, 416, 557, 624                                      | vite-dev-preview                   |
| `apps/web/tests/composer-reupload.test.ts`                   | 207, 431, 572, 639                                      | vite-dev-preview                   |
| `apps/web/tests/cover-tile.test.ts`                          | 28, 41, 79                                              | storybook-direct                   |
| `apps/web/tests/cover-viewer.test.ts`                        | 83                                                      | inspect                            |
| `apps/web/tests/csrf.test.ts`                                | 51, 184, 206, 285                                       | vite-dev-preview                   |
| `apps/web/tests/dev-dependencies.test.ts`                    | 29, 40, 61, 85, 103, 132                                | vite-dev-preview, inspect          |
| `apps/web/tests/dev-inspector.test.ts`                       | 14, 25, 51                                              | vite-dev-preview                   |
| `apps/web/tests/dev-server.test.ts`                          | 70, 74                                                  | inspect                            |
| `apps/web/tests/dev-vars.test.ts`                            | 80, 108                                                 | inspect                            |
| `apps/web/tests/fake-modules.test.ts`                        | 211, 255, 284, 301                                      | inspect, storybook-direct          |
| `apps/web/tests/focused-runner.test.ts`                      | 148                                                     | inspect                            |
| `apps/web/tests/format.test.ts`                              | 10                                                      | inspect                            |
| `apps/web/tests/generate.test.ts`                            | 24                                                      | inspect                            |
| `apps/web/tests/header-search-composition.test.tsx`          | 21, 29, 46                                              | storybook-direct                   |
| `apps/web/tests/home-cards.test.ts`                          | 187, 369, 387, 507                                      | vite-dev-preview                   |
| `apps/web/tests/home-continue.test.ts`                       | 140, 332, 352, 430, 450                                 | vite-dev-preview                   |
| `apps/web/tests/home-search-rebuild.test.ts`                 | 292, 487, 507, 589, 625                                 | vite-dev-preview                   |
| `apps/web/tests/hydration.test.ts`                           | 30                                                      | inspect                            |
| `apps/web/tests/identity-display.test.ts`                    | 132, 168, 184, 217                                      | vite-dev-preview                   |
| `apps/web/tests/inbox-list-rows.test.ts`                     | 110                                                     | inspect                            |
| `apps/web/tests/label-shelf.test.ts`                         | 23                                                      | inspect                            |
| `apps/web/tests/library-collection-editing.test.ts`          | 220, 551, 572, 649                                      | vite-dev-preview                   |
| `apps/web/tests/library-collection.test.ts`                  | 192, 334, 354                                           | vite-dev-preview                   |
| `apps/web/tests/library-copies-filter.test.ts`               | 162, 328, 347, 418                                      | vite-dev-preview                   |
| `apps/web/tests/library-copies.browser.ts`                   | 188, 484                                                | inspect                            |
| `apps/web/tests/library-entries.test.ts`                     | 156, 332, 352, 483                                      | vite-dev-preview                   |
| `apps/web/tests/library-logs.test.ts`                        | 322, 685, 710                                           | inspect                            |
| `apps/web/tests/library-mine.test.ts`                        | 151, 292, 310, 387                                      | vite-dev-preview                   |
| `apps/web/tests/library-profiles.test.ts`                    | 308                                                     | inspect                            |
| `apps/web/tests/library-progress.test.ts`                    | 306, 513, 533, 556, 625                                 | vite-dev-preview                   |
| `apps/web/tests/library-rebuild.test.ts`                     | 248, 430, 450, 565                                      | vite-dev-preview                   |
| `apps/web/tests/library-stories.test.ts`                     | 95, 107, 158, 188                                       | storybook-direct                   |
| `apps/web/tests/library-subject-slot.test.ts`                | 81, 310, 327, 391                                       | vite-dev-preview                   |
| `apps/web/tests/locale-labels.test.ts`                       | 159, 212, 231                                           | vite-dev-preview                   |
| `apps/web/tests/localization-startup.test.ts`                | 18                                                      | inspect                            |
| `apps/web/tests/media-reserve.test.ts`                       | 46, 153, 164                                            | vite-dev-preview                   |
| `apps/web/tests/media.test.ts`                               | 61, 130, 150                                            | vite-dev-preview                   |
| `apps/web/tests/mentions.test.ts`                            | 148                                                     | vitest-indirect                    |
| `apps/web/tests/meta-separators.test.ts`                     | 69                                                      | inspect                            |
| `apps/web/tests/mine-cards.test.ts`                          | 15, 27, 67                                              | storybook-direct                   |
| `apps/web/tests/native-lifecycle.test.ts`                    | 88, 100                                                 | inspect                            |
| `apps/web/tests/native/auth-stack.ts`                        | 85, 168, 191, 262                                       | vite-dev-preview                   |
| `apps/web/tests/native/library-labels.host.test.ts`          | 107, 152                                                | inspect                            |
| `apps/web/tests/native/lifecycle-injection.ts`               | 53, 68, 73, 85, 89, 191, 199                            | inspect, inspect, inspect, inspect |
| `apps/web/tests/native/lifecycle.ts`                         | 423                                                     | inspect                            |
| `apps/web/tests/native/native-auth-security-fixture.ts`      | 27, 50                                                  | inspect                            |
| `apps/web/tests/native/native-moderation-fixture.ts`         | 37                                                      | inspect                            |
| `apps/web/tests/native/private-browser-host.ts`              | 20                                                      | inspect                            |
| `apps/web/tests/native/private-browser.ts`                   | 41, 85, 454                                             | inspect                            |
| `apps/web/tests/native/search-stack.host.test.ts`            | 7                                                       | inspect                            |
| `apps/web/tests/native/stack.host.test.ts`                   | 175, 237                                                | inspect                            |
| `apps/web/tests/native/stack.ts`                             | 169, 198, 328, 432, 439, 536, 557, 821, 862, 1343, 1561 | vite-dev-preview, inspect, inspect |
| `apps/web/tests/native/subject-rating.host.test.ts`          | 88                                                      | inspect                            |
| `apps/web/tests/native/web-publication-wrapper.host.test.ts` | 57                                                      | inspect                            |
| `apps/web/tests/network-isolation.test.ts`                   | 16, 20, 27                                              | inspect                            |
| `apps/web/tests/new-thread-media-cost.test.ts`               | 85                                                      | inspect                            |
| `apps/web/tests/new-thread-media.test.ts`                    | 215, 431, 451, 518                                      | vite-dev-preview                   |
| `apps/web/tests/page-heading.test.ts`                        | 89, 126, 146, 180                                       | vite-dev-preview                   |
| `apps/web/tests/page-stories.test.ts`                        | 50, 94, 105, 130                                        | inspect, storybook-direct          |
| `apps/web/tests/platform-closed.test.ts`                     | 117, 322, 338, 403                                      | vite-dev-preview                   |
| `apps/web/tests/post-delete.test.ts`                         | 194, 316, 336, 409                                      | vite-dev-preview                   |
| `apps/web/tests/post-editing.test.ts`                        | 213, 469, 489, 560                                      | vite-dev-preview                   |
| `apps/web/tests/post-history-recovery.test.ts`               | 114                                                     | inspect                            |
| `apps/web/tests/posting.test.ts`                             | 148, 309, 329, 404                                      | vite-dev-preview                   |
| `apps/web/tests/progress-pages-layout.test.ts`               | 382, 695                                                | inspect                            |
| `apps/web/tests/progress-profiles.test.ts`                   | 479, 499                                                | inspect                            |
| `apps/web/tests/rate-limit.test.ts`                          | 52, 189, 209                                            | vite-dev-preview                   |
| `apps/web/tests/realm-pages.test.ts`                         | 308, 431, 452, 545                                      | vite-dev-preview                   |
| `apps/web/tests/record-script.test.ts`                       | 102, 110, 149                                           | inspect, inspect                   |
| `apps/web/tests/recorded-responses.test.ts`                  | 18                                                      | inspect                            |
| `apps/web/tests/recorder-isolation.test.ts`                  | 8, 16, 40                                               | inspect                            |
| `apps/web/tests/refresh-errors.test.ts`                      | 37, 127, 147, 297                                       | vite-dev-preview                   |
| `apps/web/tests/report.test.ts`                              | 146, 330, 350, 430                                      | vite-dev-preview                   |
| `apps/web/tests/request-cost.test.ts`                        | 116, 232, 247                                           | vite-dev-preview                   |
| `apps/web/tests/request-languages.test.ts`                   | 151, 214, 229, 269                                      | vite-dev-preview                   |
| `apps/web/tests/router-query.test.ts`                        | 12, 26, 34, 92                                          | vite-dev-preview                   |
| `apps/web/tests/scaffold.test.ts`                            | 20, 40                                                  | vite-dev-preview                   |
| `apps/web/tests/screenshots-build.test.ts`                   | 11                                                      | inspect                            |
| `apps/web/tests/screenshots.test.ts`                         | 44                                                      | inspect                            |
| `apps/web/tests/search-facets.test.ts`                       | 52, 118, 137, 172                                       | vite-dev-preview                   |
| `apps/web/tests/search-result-kind-navigation.test.ts`       | 94                                                      | inspect                            |
| `apps/web/tests/search-results-filtering.test.ts`            | 92                                                      | inspect                            |
| `apps/web/tests/search-results.test.ts`                      | 124, 154, 174, 209                                      | vite-dev-preview                   |
| `apps/web/tests/search-seo.test.ts`                          | 24, 96                                                  | inspect                            |
| `apps/web/tests/search-story-identity.test.ts`               | 23, 34, 74                                              | storybook-direct                   |
| `apps/web/tests/search-story.test.ts`                        | 29, 40, 79                                              | storybook-direct                   |
| `apps/web/tests/search.test.ts`                              | 59, 110, 130, 166                                       | vite-dev-preview                   |
| `apps/web/tests/security-headers.test.ts`                    | 53, 216, 247, 252, 281                                  | vite-dev-preview, vite-dev-preview |
| `apps/web/tests/server-custody.test.ts`                      | 102, 109, 140, 146                                      | inspect                            |
| `apps/web/tests/session-controls.test.ts`                    | 49, 160, 168, 191, 224                                  | vite-dev-preview                   |
| `apps/web/tests/session-token.ts`                            | 33                                                      | inspect                            |
| `apps/web/tests/session.test.ts`                             | 49, 186, 206                                            | vite-dev-preview                   |
| `apps/web/tests/settings-notifications.test.ts`              | 65, 198, 216, 280                                       | vite-dev-preview                   |
| `apps/web/tests/settings-page.test.ts`                       | 86, 223, 241, 318, 368                                  | vite-dev-preview                   |
| `apps/web/tests/shelf-page.test.ts`                          | 127, 295, 315, 425                                      | vite-dev-preview                   |
| `apps/web/tests/shell-column-height.test.ts`                 | 17, 28, 64                                              | storybook-direct                   |
| `apps/web/tests/shell-frame.test.ts`                         | 21, 42, 66                                              | vite-dev-preview                   |
| `apps/web/tests/shell-menus.test.ts`                         | 17, 29, 42, 74                                          | vite-dev-preview                   |
| `apps/web/tests/shell-navigation.test.ts`                    | 40, 140, 161, 193                                       | vite-dev-preview                   |
| `apps/web/tests/shell-phone.test.ts`                         | 86, 192, 213, 246                                       | vite-dev-preview                   |
| `apps/web/tests/shell-polish.test.ts`                        | 50, 71, 95                                              | vite-dev-preview                   |
| `apps/web/tests/shell-rebuild.test.ts`                       | 99, 203, 224, 261                                       | vite-dev-preview                   |
| `apps/web/tests/shell-toast.test.tsx`                        | 21, 29, 46                                              | storybook-direct                   |
| `apps/web/tests/shell.test.ts`                               | 31, 52, 76                                              | vite-dev-preview                   |
| `apps/web/tests/signed-in-routes.test.ts`                    | 50, 93, 101, 169, 227, 270                              | vite-dev-preview                   |
| `apps/web/tests/sitemap-serve.test.ts`                       | 338, 348, 369                                           | vite-dev-preview                   |
| `apps/web/tests/space-story.test.ts`                         | 20, 32, 64                                              | storybook-direct                   |
| `apps/web/tests/stabilize-bootstrap.test.ts`                 | 101, 106, 326                                           | inspect                            |
| `apps/web/tests/storybook-catalogue.test.ts`                 | 79, 81, 88, 89                                          | inspect                            |
| `apps/web/tests/storybook-deploy.test.ts`                    | 99, 110, 243, 245, 253, 254, 785                        | inspect                            |
| `apps/web/tests/storybook-local-manifest.test.ts`            | 43, 84                                                  | storybook-direct                   |
| `apps/web/tests/subject-labels.test.ts`                      | 41                                                      | inspect                            |
| `apps/web/tests/subject-overview-order.test.ts`              | 75, 240, 257, 333                                       | vite-dev-preview                   |
| `apps/web/tests/subject-polish.test.ts`                      | 20, 41, 65                                              | vite-dev-preview                   |
| `apps/web/tests/subject-reactions-phone.test.ts`             | 36                                                      | inspect                            |
| `apps/web/tests/subject-relation-continuation.test.tsx`      | 20, 28, 44                                              | storybook-direct                   |
| `apps/web/tests/subject-urls.test.ts`                        | 110, 151, 167                                           | vite-dev-preview                   |
| `apps/web/tests/subject-view-continuation.test.ts`           | 203, 231, 240                                           | vite-dev-preview                   |
| `apps/web/tests/subject.test.ts`                             | 27, 41, 78, 103                                         | vite-dev-preview                   |
| `apps/web/tests/support/dev-server.ts`                       | 28, 92, 201                                             | inspect                            |
| `apps/web/tests/support/pages-worker-fixture.ts`             | 28, 53, 178                                             | vite-dev-preview                   |
| `apps/web/tests/support/public-render-fixture.ts`            | 45, 166, 211, 219, 264                                  | vite-dev-preview                   |
| `apps/web/tests/support/reaction-pages.ts`                   | 119, 343, 438, 643                                      | inspect                            |
| `apps/web/tests/thread-board-rebuild.test.ts`                | 155, 198, 214, 252                                      | vite-dev-preview                   |
| `apps/web/tests/thread-replies.test.ts`                      | 162, 170, 187                                           | storybook-direct                   |
| `apps/web/tests/thread-urls.test.ts`                         | 34, 69, 73                                              | vite-dev-preview                   |
| `apps/web/tests/type-names.test.ts`                          | 88, 108, 127                                            | vite-dev-preview                   |
| `apps/web/tests/upload-memory.test.ts`                       | 49                                                      | inspect                            |
| `apps/web/tests/vite-config.test.ts`                         | 84                                                      | inspect                            |
| `apps/web/tests/worker-persistence-isolation.test.ts`        | 29, 40, 168, 214, 466                                   | vite-dev-preview                   |
| `apps/web/tests/zone-shell.test.ts`                          | 27, 47, 71                                              | vite-dev-preview                   |
| `packages/ui/tests/consumer-types.test.ts`                   | 36                                                      | inspect                            |
| `packages/ui/tests/content-actions.test.ts`                  | 14                                                      | vitest-indirect                    |
| `packages/ui/tests/cover-card.test.ts`                       | 54                                                      | vitest-indirect                    |
| `packages/ui/tests/cover-status.test.ts`                     | 71                                                      | vitest-indirect                    |
| `packages/ui/tests/cover.test.ts`                            | 80                                                      | vitest-indirect                    |
| `packages/ui/tests/document-body.test.ts`                    | 18                                                      | vitest-indirect                    |
| `packages/ui/tests/document-spoiler.test.ts`                 | 14                                                      | vitest-indirect                    |
| `packages/ui/tests/editor-images.test.ts`                    | 14                                                      | vitest-indirect                    |
| `packages/ui/tests/editor-mention.test.ts`                   | 84                                                      | vitest-indirect                    |
| `packages/ui/tests/editor-menus.test.ts`                     | 14                                                      | vitest-indirect                    |
| `packages/ui/tests/editor-slash-menu.test.ts`                | 14                                                      | vitest-indirect                    |
| `packages/ui/tests/editor-touch-bar.test.ts`                 | 14                                                      | vitest-indirect                    |
| `packages/ui/tests/entity-picker.test.ts`                    | 35                                                      | vitest-indirect                    |
| `packages/ui/tests/foundation.test.ts`                       | 158                                                     | vitest-indirect                    |
| `packages/ui/tests/media-image.test.ts`                      | 14                                                      | vitest-indirect                    |
| `packages/ui/tests/rating.test.ts`                           | 21                                                      | vitest-indirect                    |
| `packages/ui/tests/reactions.test.ts`                        | 14                                                      | vitest-indirect                    |
| `packages/ui/tests/rich-text-editor.test.ts`                 | 14                                                      | vitest-indirect                    |
| `packages/ui/tests/shadcn-base.test.ts`                      | 361                                                     | vitest-indirect                    |
| `packages/ui/tests/shadcn-stories-a-c.test.ts`               | 41                                                      | vitest-indirect                    |
| `packages/ui/tests/shadcn-stories-d-m.test.ts`               | 38                                                      | vitest-indirect                    |
| `packages/ui/tests/shadcn-stories-n-z.test.ts`               | 47                                                      | vitest-indirect                    |
| `packages/ui/tests/shelf-selection-menu.test.ts`             | 15                                                      | vitest-indirect                    |
| `packages/ui/tests/shelf-toolbar.test.ts`                    | 92                                                      | vitest-indirect                    |
| `packages/ui/tests/story-waits.test.ts`                      | 16                                                      | vitest-indirect                    |
| `packages/ui/tests/toast-composition.test.tsx`               | 46                                                      | vitest-indirect                    |
| `packages/ui/tests/tombstone.test.ts`                        | 106                                                     | vitest-indirect                    |
| `packages/ui/tests/withheld.test.ts`                         | 94                                                      | vitest-indirect                    |
