# Search identity writer custody

[The native identity contract](../semantic/identity-epoch-contract.md) owns publication. This module delivers
ordinary writer enrollment and a native structural close. **Canonical participant completion remains unavailable.**
No Search step/ACK, Library ACK, prepared coverage or whole-identity publication is manufactured here.

## Callables and composition

`identity-epoch-participant.ts` exports:

- `createSearchIdentityWriter({pool,search,index,source,listing}): SearchIdentityWriter`, whose
  `write(partition,ids,obligation): Promise<void>` reads fresh Source and actual listing counts and performs the
  existing normalized, external-versioned sink write. This is trusted ordinary projection composition. It accepts
  no document, saved version, permission flag or engine callback. `startSearchIndexing` installs it for every live
  generation, including rebuild generations. The lower-level indexer retains its existing controlled-provider
  entry point; production runner writes go through this writer. The public-filter continuation remains separate.
- `fenceSearchIdentityWriter(pool,{job,original,index,search}): Promise<SearchIdentityWriterFence>` installs the
  source-home close under `admitHomeEffect`'s actual structural admission. Its result describes the local gate,
  enrollment and settlement receipts with transaction ID **and** native component. `closed` means this operational
  key rejects enrollment; it is not complete support, old-deployment handoff, permission or participant completion.
- `createSearchIdentityEpochParticipant({search,prefix,routeKey}): IdentityEpochStep` has the exact adopted
  `(pool,job: IdentityJobRef) => Promise<IdentityStepProgress>` callable. It validates trusted deployment inputs
  and refuses unknown, nonpending or mapping-incomplete native jobs before engine work. Even with mapping custody,
  the missing owner boundary below keeps it unavailable. This is a prerequisite refusal, **not delivery of the
  complete canonical participant**. No coordinator, Accounts caller or default identity worker is bound.

## Ordinary writer ordering

Enrollment commits before Source reads and releases its native home before Source, normalization or engine work.
The Search schema contains only active operational keys `(partition,physical target,original)`, a random attempt
token, native owner/transaction/component, actual physical UUID and an optional admitted structural close.
There is no copied Source, identity membership, account fact, support registry or permission certificate.

Enrollment and first-absent structural close use the same native unique key. An existing enrollment prevents a
competing writer from reading a body; a close prevents subsequent enrollment. A close racing an enrolled writer
retains that exact writer until settlement. The writer validates Source against both the captured event obligation
and its enrollment component. Hidden, absent and redirected originals use the existing delete path. Counts come
from the supplied owner listing Source, with its existing absence semantics.

The physical UUID is resolved from exact native settings before enrollment, before mutation and after the sink
response. A different UUID or owner cannot overwrite an unresolved enrollment. The shared sink still validates
exact operation/key/version and complete shard receipts with refresh visibility. A guarded 409 rejects; refresh
alone is not a current native winner/source check.

Failure before any mutation invocation releases enrollment in a separate native command. Once mutation is invoked,
any transport, shard, conflict, incarnation or local-settlement uncertainty retains the enrollment. A crash after
engine work cannot let a newer delete pass an unaccounted old positive, including after delete-version pruning.
There is no lease expiry, force release, version synthesized from privacy state or permanent engine tombstone.
Confirmed ordinary completion removes the operational row unless a structural close retains it and the exact
settlement receipt. A lost local settlement response cannot resubmit a saved body: replay enters fresh Source
reads only after native enrollment allows it. An unresolved engine response remains a barrier; a later GET or
successful function return is not a drain certificate.

## Required owner boundary

The integrated `IdentityEpochStore` has no planned/accepted producer enrollment or effect-receiving methods.
`SubjectSource.read` hides redirected originals, and `count` cannot enumerate original support or distinguish
original privacy from terminal visibility under an admitted, unpublished mapping. The public-filter prepared
registry retains encoded input arrays; those arrays cannot certify canonical support or first-apply closure.

The precise coowner input/output needed is: given **only the native admitted job reference and a bounded retained
frontier**, resolve its immutable scope and supply current pre-publication original/terminal Source observations
(independent original privacy, terminal suitability and source-account fencing), plus the real planned/accepted
producer and OLD/NEW/first-apply handoff records with exact native receipts. The receiving producer must take those
records into job/step/version/full-scope custody, preserve prior effects across pages, and expose bounded recovery
for uncertain enrolled engine work. Search can then consume that bridge to cover physical/prepared incarnations,
retain finite progress and reconcile its actual completion receipt. Missing code here is not an empty population.
The current constructor therefore refuses instead of inventing those declarations, foreign-owner SQL or ACKs.

Operational closed rows cannot be reclaimed/reopened until that receiving lifecycle has actual custody. Existing
unregistered deployments, owner moves, retained prepared observations and ambiguous writer recovery remain part
of that integration requirement. The new guard alone does not certify them. Publication still needs the real
mapping, complete Search and ALL-Library native receipts through the unchanged Store.

## Cost and evidence

An ordinary chunk accepts at most 100 raw unique keys in one source home; the Source's existing 256-call ceiling
is unchanged. Native enrollment and settlement are separate one-home commands with indexed key operations; neither
holds a connection over Source or engine I/O. SQL input, rejected/conflicting keys, Source work, normalization,
metadata, engine responses and native command/event overhead all remain chargeable under the owning budgets.
The operational row is removed after confirmed completion; retained closes belong to the finite pending job and
cannot be called free history. No identity-step allowance or measured nine-operation Cost result is claimed.

Focused transport controls cover exact UUID receipt shape/recreation and guarded conflict refusal. Native guard,
recovery, canonical/prepared support and 64/512/4096 growth acceptance remain deferred integration proof, including
the existing native unknown-job and mapping-incomplete cases. No existing acceptance was edited.
