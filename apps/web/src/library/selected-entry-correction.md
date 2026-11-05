# Selected Entry correction receiver

The [owner](../../../../docs/library-entry-selected-correction.md) defines the native protocol and bounds.
`SelectedEntryCorrection` composes the existing Entries checkbox selection and source lifetime. Opening captures
canonical Subject IDs, incarnations and Entry revisions from current loaded rows, capped at 16. Both field selectors
start at preserve; set requires an explicit nonempty value, clear is explicit null semantics. The existing annotation
UTF-8 byte counter, priority validation and native value readers are reused.

`SelectedCorrection` holds one four-item native page and reads current personal facts for those readable identities.
The original native epoch/position is the confirmation operand. Current readback cannot acknowledge a command.
`server.ts` validates incoming HTTP operands and reuses encrypted private annotation credential custody, bound to
this receiver, the viewer, origin and session. `native.ts` quotes each logical request key exactly once. The native
review, rather than Web, owns per-item annotation request IDs and immutable operands. No annotation writer is copied.

An uncertain confirmation or cancellation remains the exact command with its captured sender; retry dispatches that
command. Cancellation first reconciles any uncertain item, then calls native cancel with the same epoch. Accepted
items survive; not-started items remain unperformed. A create response loss has no confirmed edits and cannot be
replayed as an acknowledged review. Returning can abandon that unused review to native expiry.

Reopen pages to inspect every selected item's outcomes and current native facts. Stale/unavailable items keep native
privacy: a recreated incarnation has no replacement values in its old review. Return and explicitly open another
review from current loaded identities to obtain a fresh epoch. Acknowledged confirmations refetch the existing bounded
Entries page without changing URL/filter/order/cursor, and never optimistically reorder or mutate other rows.
The shared departure registry protects drafts and unresolved commands. Source/viewer/admission retirement removes
private values, drafts and callbacks; encrypted sender custody permits same-account token rotation during retry.

Costs: one review page plus up to four addressed personal reads, one native confirmation plus the existing bounded
Entries refresh, or one native cancellation fence plus one page reopen. Memory is bounded to 16 captured identities,
one four-item page/current fact set and one uncertain command. All native admission, note, retention and response
limits remain authoritative. Browser and broader native gates remain controller-owned.
