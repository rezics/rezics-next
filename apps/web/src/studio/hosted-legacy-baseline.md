# Preparing a legacy public Book

Decision: Studio baseline preparation is a separate exact-owner review mode; each Continue sends one native step,
unknown retries replay the frozen request and CSRF binding, and 412 requires explicit new review. Point publication
remains unchanged.

`/studio?catalogueId=…&baseline=1` opens before complete-tree loading. The ordinary Book entry links directly to it,
retaining the owner account and epoch operands. It uses the existing exact `readOwn` owner reader. Append, point and
default Studio retain their existing behavior. Preparation does not load a full outline, replace a draft, publish or
activate a release. Whole-release preparation remains separate.

The author reviews the Book, original public version and private structure revision. Explicit confirmation freezes
the catalogue and both non-null version operands. Later private edits never enter the captured public source.
Continue sends precisely one installed `$advanceLegacyPublicBaseline` POST. Native `nextStep` supplies the next action:

| Next action          | Request operand                            |
| -------------------- | ------------------------------------------ |
| Initial `startBuild` | Original expected revision and publication |
| `build`              | Returned `buildFrontier`                   |
| `seal` and `receive` | Returned `sealFromFrontier`                |
| `apply`              | Complete returned `receivingCursor`        |
| `complete`           | No frontier or cursor                      |
| `done`               | No further command                         |

Frontiers and cursors are opaque. `expectedPlacementCount` labels the size of the captured source, never completed
work or a percentage. There is no polling, automatic draining or invented status endpoint. A fresh `startBuild` can
resume native retained work. Native `done` means the private baseline is ready; the existing point visit is the next
action. Its publication command still checks the original publication. No anonymous reader link implies publication.

Each acknowledged next step gets a new idempotency key. An uncertain response retains the exact original request,
key, CSRF token and session/source/locale binding. A separate owner observation cannot retarget it or prevent its
replay. The private no-store session BFF uses the existing Origin/CSRF admission and acting credential. Native command
admission owns authorization and original-version checks; it can recover a receipt without an intervening owner read.
Generated method types own both body and progress. HTTP input is closed and validated. HTTP progress validates native
cursor fields and identity, and requires the frontier named by `nextStep`; malformed or mismatched receipts remain
unknown rather than creating an invalid next command.

A 412 keeps the original version and last progress for explanation. Read the current exact owner version, then
explicitly confirm it to create a new intent. A failed owner read keeps acknowledged progress and any uncertain
request. No observation claims a successful command. A Book without a public version offers the existing point editor
for private work rather than fabricating a baseline.

The visit aborts requests, removes source callbacks and discards private state permanently on session, account or
source replacement, including ABA. The entry hides an old visit before rendering a changed owner, catalogue, CSRF
token or locale and disposes on departure. Late commands and reads cannot restore it. Feedback focus checks the same
live visit; recovery controls wrap and have a 44px minimum target. Feature copy covers all eight normal launch locales
and reuses existing Studio messages for return and loading.

Sources read before design: the installed Client `hosted-chapters-routes.d.ts` advance method; Content's
[legacy public-baseline contract](../../../../services/kernel/src/content/hosted-chapters.md#versioned-outline-adoption)
and `hosted-legacy-public-baseline.ts` input/progress/transitions; Web's
[Book acceptance](../../../../docs/goals/web.md#acceptance); `routes/studio.tsx`, `hosted-contract.ts`, exact owner reads
in `hosted-native.ts`/`hosted-actions.ts`, the point entry/lifecycle, the session request/source primitives, existing
point/root-append tests and stories; the reference index; and Impeccable's craft floor. The base already installs the
native operation, so no merge, dependency change or other owner's source is needed.

The focused `tests/studio-hosted-legacy-baseline.test.tsx` pins phase/frontier mapping, original-version operands,
one request per Continue, distinct acknowledged-step keys, stable unknown replay through owner read failure, stale
review, no publication claim, private point return, focus recovery and retirement. Its execution after integration
belongs to the dev verifier. The four illustrative story states are PrivateProgress, UnknownRetry, StaleReview and
ReadyForPointEdit, each at phone390 and desktop1280. Typing and fixtures do not establish native, visual or promotion
acceptance. The existing `hosted-book-journey.host.test.ts` browser owner lane retains mounted author-to-reader proof
and its stage journal, separating private-draft publication from the prepublished control. Browser, native, broad
acceptance and build checks remain deferred; source checks are changed-file formatting, changed-UI detection and
the affected Web typecheck.
