# Work title editorial control

G-028 implements the single English metadata title slot of a Work, in its native
adoption context. It does not authorize reuse of source expression, imply human
review, or implement generic field protection.

The target owns an immutable `EditorialControlRevision` chain and a current
`titleControlHead`. Each revision binds the Work, its exact content head, its
predecessor, monotonic epoch, originating action and source basis (record,
observation, conversion/mapping, proposal and support binding) when source-managed.
The absent control basis is explicitly `null/0`, meaning unestablished. Existing
history is never relabelled as human confirmation. Initial source application may
establish control only from the exact original Source adoption head. Any human
edit after that adoption makes this initial basis ineligible.

An edit of an established title requires the exact content head, control head,
epoch and explicit absent protection head. Equal title bytes still append a human
control revision and a content revision. Source application requires a trusted
Source reservation and source-managed control; it cannot cross human control.
Returning control is a separate `work.title.return` Access action scoped to the
Work. It advances control without changing content or relaxing protection and
binds an eligible exact source proposal. A later application still checks the
current control/protection basis. The first profile fails closed on any protection
head; review-required/sealed profiles remain prospective.

Jena checks the actual current/revision write footprint, immutable old control
revisions and the before/after state inside its native write transaction. Main
supplies an Access-issued HMAC envelope bound to the command bytes, admission,
action, scope, digest and expiry. The signer uses the independently generated `FUSEKI_TITLE_ADMISSION_KEY`,
provisioned into the Access adapter and native verifier through private stack
environment files. Jena refuses reuse of either Fuseki credential as that key; possession of the ordinary command credential alone is
insufficient. This is an application trust boundary, not proof against a
privileged operator or a compromised Main process.

Source reserves operations durably under the existing support-head row lock.
Withdrawal is denied while an outcome is unresolved. A timeout never releases
that reservation; settlement requires the original success/cancellation receipt.
No PostgreSQL call or remote observation runs inside the Jena writer.

Reads use the Work's exact control-head pointer and one immutable revision.
Commands touch one Work and at most one content and one control revision;
source eligibility uses indexed identity/support lookups, never Work-wide history.
Recovery must retain the exact control envelope and restore it under the existing
held-owner frontier. Missing control coverage does not reopen source control.

This design reuses [Jena's single native writer and transactional visibility](https://jena.apache.org/documentation/tdb/tdb_transactions.html)
and [PostgreSQL row locking](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS).
Those mechanisms do not prove the combined protocol; owner races, forged
admissions, lost responses and graph-loss replay are the required falsifiers.
