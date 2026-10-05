# Content draft protection template

The first owner binding is `content-draft-protection-v1`: one Content variant's
`draft_head` and optional `protection_head`. Migration 130 serializes every draft
writer, protection change and correction application on the existing variant row.
It appends immutable protection, proposal, decision and application records. The
Content receipt and outbox are written in the same transaction; the command
returns the position the Content sequencer assigns after commit.
Migration 131 adds a proposal-scoped private-principal comparison key; public
proposal reads omit it. `null` protection means asserted absence for this profile.
Main resolves a lost Content acknowledgement from that operation's receipt and
returns a pending handle if the receipt cannot yet be read. Terminal outcomes
seal the matching Access admission through the owner receipt-family declaration.

`content-store.ts` is the owner write/read template. Copy its operation lock,
recorded-receipt replay, target-row lock, exact basis checks, and single-commit
receipt/outbox pattern for another Content-owned target. Copy `admitted.ts` for
Account/Access admission and distinct actions, then `routes/protection.ts` for
typed transport and current read disclosure. A graph-owned target uses the
Work command template described below.

## Cost contract

One mutation touches one variant, one receipt and one outbox event. It reads at
most one prior proposal, one candidate and one decision by key, plus at most 32
exact evidence references and a candidate of at most 1 MiB. The owner command
does not scan unrelated variants or proposals. `editorialStates` admits at most
50 targets through variant primary-key lookups. Correction history reads at most
51 rows from `(variant_id, created_at DESC, id DESC)` to return 50 and a cursor.
The cursor is bound to its target; over-limit requests and malformed continuations
are rejected. The focused store tests exercise 50/51 pagination and bounded
target reads; integration tests exercise Account/Access admission and HTTP replay.

Protection changes, correction proposals and decisions use the
`editorial-protection-v1` Content outbox recipe. Their events are acknowledged
in order by the Content projection relay and do not create graph outbox events or
new published Content models, so this binding declares no graph event handler or
search projection recipe. The owner's `strongRevokeProtectionScope` and
`strongRevokeProtectionPrincipal` perform
bounded 100-admission reconciliation passes using the Content receipt; unresolved
work stays pending behind the Access fence.

## Graph Work title template and field extension

`work.ts` writes the first graph-owned profile for the Work's stable English
title slot in its native adoption context. It uses the existing Work revision
anchor, current head, title-control epoch, command receipt, graph outbox and
Access admission. `ProtectionPolicy` and `TitleControlPolicy` check the actual
TDB2 transaction footprint and exact before/after heads. In `review-required`
mode, ordinary edit and source apply cannot change the adopted title. A proposed
candidate is a retained Work manifest and immutable revision anchor; only a
separately admitted, independent review can adopt it. A terminal decision has a
deterministic identity per proposal, and approval and application are one commit.
Relaxation appends an `Open` protection revision, after which ordinary editing
again requires the exact new protection head.

For G-093's generic field control, reuse `field-control.ts` for the stable
definition/occurrence/context slot identity and the exact nullable control and
protection basis, then the title binding in `modules/work/title-control.ts`
for the content head and monotonic control epoch. Reuse the Access proof pattern in
`modules/access/protection-admission.ts`, the immutable proposal and decision
profiles, and the transactional checks in `ProtectionPolicy`. Identify a field
by its admitted definition, occurrence and adoption context; never derive its
identity from its current literal or an array position. Add an owner-specific
field footprint and canonical SHACL route before allowing that field's writes.
The Work title uses `"title:en"` as the retained protection/correction slot key,
independent of the title's language. New title control revisions use the `"title"`
field with `controlLanguage`; the adopted `rdfs:label` carries that language.
This is one concrete binding of the protocol. A new field
writer must guard every writer that can alter its adopted projection, including
source and legacy commands, and preserve exact absence semantics. A new field
also needs its own read and history route, receipt family and event declaration.

The graph template admits one target, at most 32 evidence references, and one
candidate no larger than the existing Work title payload bound. The writer
uses point reads of the Work head, proposal and Access admission, plus one
bounded graph command. It never scans unrelated Works or correction logs.
`tests/qa/integration/protection-work-api.test.ts` exercises the complete
admission, owner commit, receipt, outbox and ordinary-edit transition.
It also verifies that a sealed Access admission with a missing graph receipt
stays pending. Restoring a cut that lost Work protection or correction records
uses `recovery-evidence.ts` to copy the exact bounded revision, receipt and
outbox triples into the separately retained relay event. During a held restore,
`reconcile-restored.ts` checks the sealed Access admission, original request
digest, old data epoch and ordered replay cursor before applying each graph
effect with the ordinary protection shapes and a fresh Access signature.
The release gate compares the signed owner, relay, graph and immutable-object
coverage after the protection, proposal and decision effects have replayed.
Replay does not hand off an outbox event again; the old delivery stays in the
retained relay, while the new data epoch starts at sequence zero.

Recovery cost contract: relay capture performs one indexed lookup by operation
and point reads of one receipt, batch and event, with at most 192 triples and
128 KiB of query response. Each replay first rechecks relay coverage in
1,000-row pages, costing O(B + E) for B retained batches and E retained events
through the checkpoint; the shared relay helper owns that bound. The replay
then reads one event and one sealed Access row, performs bounded point reads
of the target Work and its proposal,
and writes at most those 192 triples plus one Work or correction-log current
projection and one replay cursor. Unrelated Works and correction histories are
not scanned. The SYS13 fault test checks the hard triple bound, ordered replay,
duplicate replay, held release and zero new-epoch delivery against a stopped
graph cut and promoted PostgreSQL backup.
