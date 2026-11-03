# Library entry state history and recovery

Personal state history belongs to the native entry owner. It records actual state or profile-pin transitions made by
the ordinary entry writer, including installed importers that already call `putEntry`, and explicit state recovery.
Notes, priorities, progress, copies, follows, source uploads, audit records and public contributions remain with their
existing owners.

## Installed contract

The private Kernel command methods are:

- `listEntryStateHistory(actor, subjectId, { cursor, limit })` — returns the current live incarnation, revision,
  bounded newest-first changes, coverage and a signed continuation.
- `reviewEntryStateChange(actor, subjectId, changeRevision)` — returns the selected recorded transition and the
  current live state, then says whether its before-state is currently admitted.
- `restoreEntryState(actor, subjectId, changeRevision, { incarnationId, currentRevision }, requestKey)` — applies
  the selected before-state as a new revision-guarded command with the caller's original idempotency key.

The owner-only HTTP routes are `GET /v1/libraryEntries/{subjectId}/state-history`,
`GET /v1/libraryEntries/{subjectId}/state-history/{changeRevision}`, and the AIP-136 restore action
`POST /v1/libraryEntries/{subjectId}/state-history/{changeRevision}:restore`. Reads require
`library_entry:read`; restore requires `library_entry:update`, current personal-library admission and the ordinary
entry owner's command receipt. Other owners, anonymous readers and terminal accounts receive no history payload.

Restore conflicts use `library_entry_state_restore_stale` when the reviewed incarnation or current revision changed,
`library_entry_state_restore_unavailable` when the selected record has no prior live state or its state is no longer
admitted by the current identity and released profile, and `library_entry_state_restore_unchanged` when applying it
would have no effect. Missing, deleted or foreign live entries and missing changes remain `not_found`. These routes
never restore a deletion receipt or extend its 720-hour window.

## Recorded evidence and coverage

Each changed native effect stores its prior and resulting state and profile pin, prior and resulting revision,
incarnation, native command transaction ID, command kind and native command time in the same transaction as the entry
write. A creation is represented as an absent-to-state transition. A write with the same state and pin stores no
change row; receipt replay returns the original result and writes no second row. Importers do not receive a separate
capture adapter.

Rows are indexed by account, subject, incarnation and revision. History pages examine at most `P+1` indexed rows for
page size `P` (default 20, maximum 50). Continuations bind the owner, subject, incarnation, page size, current entry
revision and partition epoch; a changed current entry makes the cursor stale. At most 64 changes are retained per
account and subject across incarnations. An insert beyond that cap prunes the oldest row and marks any affected
retained incarnation incomplete in the same transaction.

Coverage is `complete` only when the retained rows prove state-change coverage from the entry's captured creation;
it is `partial` when the first captured transition followed an older entry or retained rows were pruned; it is
`unknown` when the incarnation has no captured change rows. No migration fabricates an empty complete history for
pre-installation entries. A captured before-state from a later edit is still exact evidence, but it does not fill the
earlier gap.

Review binds one selected change to the currently live incarnation and reports its current revision and state. It
checks the historical state ID against the currently released profile and current Subject identity. Restore repeats
that admission after receipt lookup, locks and rechecks the current entry and selected change, and writes the old
state ID with the current profile pin. Historical pins are evidence only; they never grant permission or define the
new write's meaning. The caller's command ID and time describe the restore, while source, audit and consumption
timestamps remain their existing separate records.

## Retention, erasure and cost

Entry deletion makes history unreadable because every read first requires the live owner entry. Deletion Undo keeps
the same incarnation's retained history; expiry of the existing deletion receipt removes that incarnation's history
with the archived entry. Account-fact purge removes history for each indexed account/subject, and terminal erasure
probes the history table before acknowledgement. History is not emitted in outbox events, public DTOs, Search or
error bodies.

For one state transition, the writer adds at most one change row and prunes at most one row after the 64-row
account/subject cap is reached. A page reads at most `P+1` indexed history rows plus the current owner entry and
fixed authority checks. Review reads one selected change plus the current entry/profile; restore reads one selected
change and the current entry/profile, then uses the ordinary native edit, owner sequence and support transition.
Account cleanup examines bounded subject pages, with at most 64 retained changes per subject. These are derived
storage bounds; native growth, buffers, bytes and cleanup remain controller acceptance work.

Focused native coverage is in `services/kernel/test/library/personal-http.test.ts` and
`services/kernel/test/library/account-fact-purge.test.ts`.
