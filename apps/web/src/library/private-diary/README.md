# Private journal departure

The [Library private diary contract](../README.md#journal-and-history-reading) owns reads, explicit journal correction
and occurrence lifecycle commands. This directory owns the occurrence caller's local departure integration.

## Consumption history transport

Decision: bind the incoming request signal to the diary page and its selected summary, with private no-store and
manual redirects on every generated native GET. Keep cancellation commands independent of the abandoned read.

One visit requests exactly one page of 25 at its supplied year, month and opaque cursor, plus either the all-time
summary or the selected year's summary. The siblings run independently: one native refusal or transport failure
does not discard the other's useful result. A redirect remains an unavailable read and is never followed with the
reader's authorization. The BFF response remains private/no-store; existing page and summary admission budgets stay
with their reading owners.

Session preparation receives the same incoming Request. Its current session RPC has no abort parameter, so abort
checks bracket preparation and prevent native reads from starting after departure. Each native GET receives that
request's signal and checks it before dispatch and after completion, including a client-normalized transport abort
or a late response. An abandoned or replaced request rejects instead of returning an empty page, a signed-out
reading or a recoverable sibling failure. A replacement has its own signal and exact address. No retry, refill,
polling, abort listener or private persistence is added; cancellation costs only the original two reads.

Continuation cancellation retains its original viewer/CSRF admission, continuation body and receipt meaning. It is
not bound to the departing read's signal. A read abort cannot prove that a dispatched mutation was unapplied or
replace its original receipt.

Design sources: this owner, `native.ts`, `server.ts`, the linked Library journal/history owner, the existing
`yearly-goal-native.ts` private fetch policy, `subject-slot.ts` session signature, installed client declarations and
the read-only main checkout `.reference/INDEX.md`.

Acceptance source: `private-diary-transport.test.ts` exercises the real generated HTTP seam for exact operands,
private fetch policy, request signal propagation, independent sibling failures and replacement/abort. Execution is
deferred to integration verification, followed by the existing mounted history/journal and native acceptance.

## Journal departure

Decision: register the journal in the existing Progress departure decision; a pending save offers Stay, while an
unresolved or acknowledged save permits deliberate Leave without altering the sealed request. Keep useful editing
independent of that request. An isolated occurrence caller installs the same boundary.

Any chosen field is a draft, including Clear, empty reflection text and incomplete dates. Untouched fields and a
settled save without later edits need no prompt. Review and Correct retain the same selections. Stay and dialog
dismissal retain exact fields and return focus to the initiating control. Leave discards only registered callers'
local drafts, never a native save. Route links, Back/Forward and document departure consult the same state. Native
document departure uses the browser's confirmation; it cannot run a local discard callback.

A pending request stays available until its response. A lost response remains uncertain; an acknowledged write
without independent readback remains acknowledged. Fresh current observations cannot settle either. The original
body, viewer, credential, revision, key and comparison remain unchanged for exact Retry. Fields remain editable
after dispatch, but cannot create a second command before the first settles. Success clears only the submitted
selections; selections edited after dispatch remain local drafts. Reading current values stays an explicit action.

Account, credential, occurrence, source lifetime or return-context replacement retires the caller. Retirement cancels
an open departure decision and suppresses focus return to old controls. Late command results cannot restore that
dialog or write into the replacement. Only the existing reader lifetime may retain a dispatched command through a
read replacement; no unsent draft is persisted. Occurrence reopen and retirement follow the lifecycle recovery
rules below.

The boundary derives constant local state from four selections and the existing command. It adds no request,
writer, cache or persistence. Navigation confirmation supplies no native authority.

Acceptance source: `private-journal-draft-navigation.test.tsx` and `private-occurrence-assessment.test.tsx` cover
mounted departure, Clear, settled saves, independent editing and original retry, retirement and replacements.
The named journal stories are in `stories/private-diary.stories.tsx`. Compiler, tests, native, keyboard, phone,
themes, all eight locales and browser acceptance are deferred to the verifier.

## Occurrence lifecycle recovery

Decision: Cancel is available only before dispatch; retain one frozen lifecycle request and its captured sender in
this occurrence's existing reader lifetime for exact Retry, while current reads and conflict review stay separate.

An unsent review captures action, occurrence, viewer, credential, revision and key. Cancel returns to its launcher
without changing journal selections. Dispatch removes Cancel and prevents another action or a journal write from
replacing the unresolved request. Pending and unknown results have distinct messages. Original Retry reuses every
captured operand and sender, even after current observations change. Reading the selected current occurrence never
proves that original write; its state and revision remain explicitly labeled observations. There is no new read
endpoint, polling, history scan, per-row request, persistence or departure mechanism.

Journal fields remain editable while lifecycle recovery is pending or unknown. Lifecycle responses do not alter the
journal's submitted comparison, original save, newer selections or shared Stay/Leave decision. Acknowledged retirement
uses the existing terminal history navigation. A lifecycle conflict releases the refused request, rereads the existing
selected occurrence and exposes recovery outside the journal editor. A fresh revision must be explicitly reviewed
before another lifecycle review captures a new command. Viewer, credential, source or mutation permission replacement
retires inappropriate controls and late effects without reporting a failed mutation. An unrelated permission change
does not replace either original request or its known acknowledgement. Reader retirement cannot restore
old controls. Focus follows deliberate review/cancel or response recovery only while the person stays in that control.

Design sources read before implementation: this owner, the linked Library journal/history owner,
`occurrence-detail.tsx`, the exported `occurrence-server.ts` contracts, the journal departure adapter and focused
occurrence/departure tests, `stories/private-diary.stories.tsx`, and the read-only main checkout `.reference/INDEX.md`.
Native authorization and reopen/retire transports retain their existing contracts.

Acceptance source adds unsent cancellation, pending and unknown preservation, exact replay after an independent read,
newer journal fields and departure, lifecycle conflict without opening the journal editor, and reader/authority
retirement with late results. Source review does not establish execution: occurrence/departure suites, compiler,
native lifecycle/journal acceptance and phone/desktop/theme/locale/keyboard/promotion remain with the verifier.
