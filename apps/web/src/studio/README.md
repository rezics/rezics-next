# Studio

`/studio` is the signed-in account workspace for private discussion drafts. It consumes the bounded Content
own-drafts inventory, opens only an explicitly selected discussion opening, and uses the existing Studio editor,
revision history and comparison. The inventory is account scoped; it does not imply project membership. Each page
contains at most 20 rows, keeps its opaque continuation, and retries the exact failed cursor.

Studio creates a private discussion with the selected board, nonempty body, title, licence, subjects and media IDs.
The generated `thread.create` operation receives draft visibility and one stable idempotency key. Acknowledged drafts
use the current exact-resume reader and the conditional revision writer for later edits. The editor retains one
selection and one working document; it does not add a second body store.

Before account publication, Studio freezes the acknowledged Post revision and digest, body, board, licence, subjects
and media IDs in a local review. Editing retires that review. Publication uses the installed conditional revision
command with the exact `If-Match`, captured session credential and original idempotency key. An uncertain outcome
retries that same intent; a new observation is a separate action. Studio reports publication only after an exact
current-post readback agrees with the acknowledged body and operands.

Hosted Books stay on `/studio?books=1`. Their selected-manifest review and hosted publish command remain independent
and atomic. The manifest freezes exact chapter bodies and required table-of-contents ancestors; later draft edits and
unselected drafts do not enter the release.

The route uses public Threads and Content entries and the installed generated operations. Native authorization,
session retirement, producer recordings and the mounted native/browser acceptance remain separate verification
responsibilities. `studio-native-drafts.stories.tsx` labels its supplied outcomes as illustrations, not native proof.

Decision: Studio owns one account-draft inventory and private creation flow, composes the existing exact-resume and
revision lifecycle, and keeps local acknowledged-revision publication separate from hosted Book publication. Studio
exact document operations use a focused Content public entry that exposes only those operations and required types;
implementation stays in Content and Studio remains the receiving owner.
