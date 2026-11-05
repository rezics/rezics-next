---
goal: web
manager: web
---

# Complete paired buyer list receiving lifecycle and presentation

The coordinate-only model and its tests are delivered in buyer-history-windows.ts and purchase-return.test.tsx.
Navigation ownership and exact bounds are in apps/web/src/checkout/buyer-history-navigation.md.
Production readers and pages are unchanged; the full requested journey is unfinished.

Web buyer navigation/lifecycle owner: supply the retained eligible Router/QueryClient visit seam. Current
BuyerCurrentOrigin retires at every href change and cannot itself retain both paths across list/detail/Edition.
Do not weaken it, alter the Edition reader/shared command hosts, add a registry or another session observer.
Bind the model to the existing observation's synchronous retirement, including equal replacement and A/B/A.

Then connect the two current readers: stage before one bounded read, admit exact current-reader ready responses
only, preserve failed raw targets for explicit Retry, and keep only the current body. Route loader preparation
must not add a duplicate movement read or admit history. Preserve existing malformed/stale explicit recovery.

Add canonical Previous/First/Next links, eligible ordinary router clicks, eight-locale labels and exact Retry,
44px phone actions, status announcements and keyboard-only once-consumed heading focus. Preserve sibling cursor
and exact detail/Edition origins through supported returns. Add the complete mounted paired journey/terminal
backward/failed retry/replacement tests in the declared files and adapt at most one Orders story. The new model
unit coverage does not establish actual reader admission, observer replacement or mounted return behavior.

Controller retains original native/browser/installed phone390/desktop1280 and integration acceptance custody.
Run changed focused files with the prescribed focused.ts runner and typecheck apps/web after committing edits.

## Attempt verification

Committed source: c8d73bd4a3. The prescribed focused runner changes cwd to apps/web; use:
`bun apps/web/scripts/focused.ts --private-network -- bun test ./tests/purchase-return.test.tsx`.
Actual result: 3 passed, 1 failed. Both added coordinate-model tests passed. The retained original rendered-return
assertion fails with `TypeError: undefined is not an object (evaluating 'order.currency.toUpperCase')`.
Its `order-paid.json` recording has no currency; the recording and OrdersPage are unchanged from base
6631fb964f1a4aa6b6b0f15b61fe012a7b5a0074. This is an inherited fixture incompatibility, not a green focused file.
The recording/native-factory owner must provide the complete typed buyer history projection; do not handwrite
missing money fields or weaken the original return assertions. An earlier invocation with the repository-relative
test path matched no files and was corrected as above.

`bun run --cwd apps/web typecheck` exited 75 before proving compilation:
`root typecheck infrastructure failure: compiler database setup could not be proven: spawnSync docker ETIMEDOUT`.
No successful type-check is claimed. Native, browser, installed signed-in phone390/desktop1280, root and broader
acceptance were not run and remain with integration. No services, containers, publication or captures were started.
