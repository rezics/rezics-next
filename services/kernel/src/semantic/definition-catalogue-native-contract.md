# Native definition catalogue publication

An authorized administrator uploads bounded addressed artifacts, starts a build, advances its durable index
checkpoints and activates a ready immutable root through the ordinary definitions commands. Core owns fresh
Access authorization, receipts, transaction fencing, outbox events, replay and uncertain commit handling. A denied
command creates no success receipt. A lost reply is recovered with the same command identity; an unresolved mutation
remains uncertain. Publication requires no runtime price quote, parent allocation, funding ticket or dispatch profile.
Historical funding rows remain retained records and are never interpreted as authority for new commands.

## Publication and continuation

`publishCatalogueArtifact`, `startCatalogueBuild`, `stepCatalogueBuild` and `activateCatalogue` use the normal
`commandOptions` and `runCommand` path. Addressed bytes and immutable identities retain their original validators.
Missing bytes produce an incomplete checkpoint; malformed or contradictory artifacts produce a retained refusal.
A build never publishes partial indexes. A ready build requires exact condition and presentation Type/profile closure.

One step visits one directory node (at most 256 entries), one Release member page (64), or one declaration label
page (64). Indexed operations and parameter/output bounds live in `definition-catalogue-work-cost.ts`.
`CATALOGUE_COMMAND_BOUND` adds the fixed alternatives and their structural repetitions, including failure and
rollback branches, four activation transitions and one retirement component. This is a static request bound;
there is no catalogue-size limit inferred from a page size and no prepaid whole-job schedule.

The scheduler supplies the committed job's position to `runCatalogueBuildStep` or `runCatalogueActivationStep`.
`definition_catalogue_checkpoint` stores at most 65,536 result bytes per exact root/phase/job/position in the same
native transaction as its mutation. The build row, or the head then root rows for activation, serialize lookup,
mutation and result insertion. A repeated position returns the original committed result even after other commands
advance the job. Rollback removes both effects and checkpoint; a lost reply cannot create another effect. Public
command replay continues to use Core receipts. Mechanical work advances only an existing authorized build or intent;
final publication always requires a fresh `definitions:activate` command.

## Enrollment and withdrawal

A new invisible build registers its enrollment row in its creation transaction. Historical unproven roots are never
certified empty. Every enrollment, root close and final CAS locks head before root. Closure captures the exact
generation and last sequence. A competing activation cannot acquire the same expected head's retained cut.

Automatic Collection presentation no longer enrolls catalogue consumers or calls Accounts Kind preparation.
The metadata head, exact descriptors, signed label pages, candidate pages and historical Release adapter retain
their ordinary read authorization and bounded response contracts. An unset Collection `presentationKind` means mixed
presentation: each member uses its own released Type hints. Explicit owner selection remains presentation data;
it does not alter membership, disclosure or the member's actual Type.

`enrollCatalogueConsumer` is the minimal seam for a native dependency owner that still needs a current catalogue.
The ordinary owner command retains bounded canonical consumer, provenance and dependency bytes, including negative,
pending and uncertain decisions. The exact tuple determines identity. Enrollment is permitted only on the open
current root and only for an installed `CatalogueConsumerSource`. The Source adapter is trusted host composition,
never caller JSON or an admission/proof protocol.

Activation stages at most 100 immutable captures at a time. A missing current consumer, changed provenance,
missing adapter, unavailable withdrawal or uncertain mutation retains the obligation. The Source adapter's
`readCurrentWithdrawal` reads its own committed withdrawal, verifies the current owner and restore generations,
and guarantees that this exact dependency cannot revive. Library release/hold receipts, historical owners and
precommit transaction locators do not meet that interface. The returned acknowledgement binds the digest of the
entire exact capture, including the closed root generation, and a bounded durable receipt. Semantic compares the
current enrollment tuple again in the statement that records the acknowledgement and removes its frontier slot.
This transaction either commits both or neither. The consumer retains the receipt and exact owner/restore generations.
A later owner or restoration cannot reuse the withdrawn dependency; it requires enrollment on the new open root.

Final publication requires staged sequence equal to the closed cut, no pending frontier and no unresolved old-root
consumer, as well as the exact durable generation and current head. These are database predicates, never a caller's
complete flag. An empty cut publishes normally without a Source adapter. A nonempty cut stays durably pending until
its native Source adapter supplies current withdrawal; the ordinary caller receives dependency unavailable and can
resume with fresh final authorization. No Source adapter is installed for the removed automatic-Kind journey.

Retirement retains unproven roots, unresolved Source obligations and historical unsettled originals. Bounded cleanup
never refunds historical allocations or deletes the current head. Build/artifact provenance and acknowledged
consumer audit rows remain retained; publication does not depend on deleting them.

Decision: Use ordinary Core command receipts for public replay and a same-transaction job-position checkpoint for
mechanical replay; retain historical funding records without creating new allocations.
Decision: Keep a named native Source withdrawal adapter for real current consumers; mixed Collection presentation
creates no consumer and requires no preparation or withdrawal work.
