# Native edition publication and withdrawal growth

Source inspected: `d50464392475ae4a76362a7ed0bb1e9646126501`.

## Operation binding

The selected commands are the real `POST /v1/contentEditions/{id}:publish` and
`POST /v1/contentEditions/{id}:unpublish` routes mounted by `createKernel`. The fixture provisions its author,
released subject, protected source revision, board, Realm and Space through the existing native Content and Auth
boundaries. The observed kernel shares the fixture's native Access instance and current Auth consent reader. The
selected edition and its grants are created through `POST /v1/contentEditions`; revisions used for source-history
pressure are created through `POST /v1/posts/{id}/revisions`.

`checkGrowth` observes the instrumented Pool used by that kernel. Its measured callback contains only the selected
HTTP command. Growth setup and command preparation run outside that callback. The command still traverses normal
route admission, current creator and source checks, subject and parent reads, expected-head CAS, executor-owned
transaction, receipt, and outbox event. No registered worker participates. The fixture raises only its per-account
write admission allowance so the 4,096 supported revision writes can be prepared; the measured Cost bounds and
native authorization remain enabled.

## Independent axes and assertions

Publication and withdrawal are measured separately at 256, 1,024 and 4,096 rows for each axis:

- Other editions in the same route, seeded before observation with the admitted growth helper.
- Revisions on the selected source post, written through the native revisions endpoint while the edition remains
  pinned to its original exact revision and body.
- Retained publication operations, receipts, write bases and events for unrelated same-route editions, seeded before
  observation with the admitted growth helper.

The selected subject, pinned source revision and body do not change; only the source post's current head advances on
the source-history axis. The native actor scope count is fixed and asserted at no more than 512. The publication
operation and its receipt are produced by the real command; the test checks their
shared transaction, request digest, creator basis, event position, replay identity and single-row counts. The terminal
withdrawal retains that original publication record; the test does not attempt to republish a withdrawn edition.

Each series uses constant rows and statements and logarithmic shared blocks, then checks all captured relation paths
with the shared `assertGrowthAccessPaths` classifier. It requires captured edition, post, revision, receipt and outbox
relations, plus publication provenance for the publish command. The setup runs outside each measured callback, so its
HTTP calls and seeded history do not enter the command's Cost sample.

The behavior assertions cover a successful publication and exact replay (HTTP 200, one publication receipt, event
and immutable operation), competing expected-head publication (one HTTP 200 and one HTTP 412; the loser leaves no
receipt, event or operation), creator-action and source-action revocation (HTTP 404, with no receipt, event or
operation), and successful terminal withdrawal plus replay (HTTP 200; later publication is HTTP 404). Refusal
assertions inspect the selected edition, receipt, publication and outbox rows after the command boundary.

## Execution limit

The test and this binding report are authored evidence only. The controller launch context defers acceptance, native
and browser checks until integration, so this worktree has no measurement run or passing-check claim. Integration must
run `bun run --cwd services/kernel check test/content/growth-edition-publication.test.ts` to produce measured
acceptance evidence.
