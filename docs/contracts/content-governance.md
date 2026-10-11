# Content governance and rights complaints

The governance owner keeps reports, exact evidence, decisions, reversals and
enforcement separate. Its [schema](../../services/main/src/modules/governance/schema.ts),
[capture](../../services/main/src/modules/governance/evidence.ts) and
[effects](../../services/main/src/modules/governance/effects.ts) carry the
implemented boundaries. [GOV01–03 and GOV24–25](../../scripts/qa/cases/governance-and-delivery.ts)
name their acceptance results.

## Work publication and structured disclosure

An authored Work may be published when its public content is an explicitly
selected Structure. The first opt-in profile is `recipe-composition`; other
profiles remain closed until their owners opt in. A current represented Work
maintainer may publish without independent review, through the public operation
with its ordinary exposure, Access and rate-limit checks. This gives structured
Works an explicit publication path without turning every Structure into public
content.

Publication retains the exact immutable Structure revision that was selected.
An edit stays private until the maintainer publishes again. This keeps a saved
draft from changing the public page without another publication decision.
Public text publication and `catalogueVisible` keep their existing effects on
the Work and its public text. Structured payload and Structure history become
public only through the explicit Structure selection, so public text or
catalogue metadata cannot expose an unselected structured draft.

The first rights basis is the original-contribution declaration bound to the
admitted Structure provenance and recorded with exact source and actor evidence
in the immutable publication decision. Every contribution in the selected root
must be attributable to a current represented maintainer of the Work, and each
must have an original-contribution declaration from admission. Contributions
by other editors, imported instructions, referenced materials and media are
refused in this scope; unknown or unsupported bases remain refused. Work edit
authority does not establish rights clearance. The exact Structure identity
stays with its existing immutable provenance; this policy does not create a
RightsStore assessment or a Content revision for publication.

Publication is denied while the publisher has a platform participation
restriction, the Work or its parent container has an active restriction,
takedown or rights notice, a recovery hold is active, or the relevant gate is
closed. Reading continues to use the existing disclosure effects; publication
does not add a publication-specific suppression effect. Withdrawing a
publication revokes that decision rather than creating a disclosure
restriction. Suitability and target-media checks remain reader-side. Readers
re-fence the Work after hydration, and an unavailable owner fails closed. These
rules keep current safety and disclosure owners authoritative across
publication and reading.

A current Work controller or represented Work maintainer may privately preview
their authored native Work without an individual `work.read` grant through the
current maintainer row only. Identity verification, transfer revocation, closed
gates and recovery holds still apply; an explicit policy deny wins. A bare edit
permission does not establish the row. Publication does not grant this preview,
and a private preview is never evidence of anonymous public visibility. This
aligns an author's private review with current Work representation while
keeping public disclosure a separate decision.

Publishing the selected Structure and publishing notes are two explicit API
steps. Each binds its own exact revision and idempotency key; the steps do not
share an all-or-nothing transaction. The editor reports each result separately,
so one part can succeed while the other remains pending or refused. This
preserves the boundaries and recovery behavior of the existing publication
owners.

## Rights complaints

The [source policy](source-lifecycle.md#basis-for-acquisition-and-reuse) favors
intake with provenance, followed by a decision scoped to the affected material
and uses. A complaint is an allegation, not a finding. Human review determines
whether an ordinary dispute or the applicable notice/counter-notice process
governs each step. Where § 512 applies, qualifying notices or relevant knowledge
call for expeditious action; an interim restriction need not await a final merits
decision. The [legal review](../research/source-data-rights.md#complaint-handling-and-section-512)
records conditions and limits, without establishing safe-harbor eligibility.

## Remaining work

Thread-root removal must preserve other authors' posts and original reply targets.
Bulk case effects need paged recovery. Separate erasure work must decide when
physical deletion overrides retained case evidence; suppression and reversal do
not recreate erased payloads. These behaviors need their own owner tests before
the page can be retired.
