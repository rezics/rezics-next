# Private journal departure

The [Library private diary contract](../README.md#journal-and-history-reading) owns reads, explicit journal correction
and occurrence lifecycle commands. This directory owns the occurrence caller's local departure integration.

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
read replacement; no unsent draft is persisted. Reopen and delete retain their existing command ownership.

The boundary derives constant local state from four selections and the existing command. It adds no request,
writer, cache or persistence. Navigation confirmation supplies no native authority.

Acceptance source: `private-journal-draft-navigation.test.tsx` and `private-occurrence-assessment.test.tsx` cover
mounted departure, Clear, settled saves, independent editing and original retry, retirement and replacements.
The named journal stories are in `stories/private-diary.stories.tsx`. Compiler, tests, native, keyboard, phone,
themes, all eight locales and browser acceptance are deferred to the verifier.
