# Private annotation and occurrence journal export

The native owner API and artifact format are defined by [Personal Library export](library-export.md). This page
records how the delivered personal-entry and progress-session fields cross that boundary. It does not add another
export endpoint, archive store, importer, or Web page. Web remains the sole private export interface at
`/library/export`.

## Version 2 and 3 records

Existing version 2 captures keep their installed meanings. New captures use format version 3, which keeps the
version 2 `annotations` section with one record for each retained personal
annotation revision, including values the owner explicitly cleared. A missing annotation fact or revision zero is
not emitted. The record contains `accountId`, `subjectId`, nullable `entryIncarnationId` and
`libraryProfilePin`, `annotationRevision`, `note`, `priority` and `annotationUpdatedAt`. The entry join is optional:
an annotation stays exportable if the Subject has no current entry row. A null note or priority is preserved as null.

The `provenance` section contains one record for each accepted native source observation. Its nested `observation`
uses the owner DTO fields `provider`, `recordId`, `revision`, `privacy`, `sourceCreated`, `sourceUpdated` and
`recordedAt`. Known timestamps keep their source string, precision and zone. `absent`, `unknown`, `cleared`,
`private` and `source_visible` remain distinct. `recordedAt` follows the installed observation DTO's audit/update
time and remains separate from both source timestamps. No raw upload, credential, review capability or provider
identity is reconstructed.

The V2 `journals` section contains one record for each non-retired occurrence whose journal revision is greater than
zero. It keeps the owner, `sessionId`, Subject/version identity, occurrence state, original `libraryProfilePin`,
`progressRevision`, and separate native progress times. The nested `journal` uses the delivered shape
`{sessionId,revision,startDate,finishDate,reflection}`. Its revision is the journal-local revision; the enclosing
`progressRevision` is the independent occurrence revision.

V3 keeps that exact record and appends `assessment:{meaningRevision:1,units:number|null}` inside `journal`. Units are
integers from 0 through 20 in steps of 1. Null remains distinct from zero and is never inferred from a missing field.
The assessment is a private per-occurrence fact, not a public Subject vote or the Content standard question. Unknown
meaning revisions and unsupported values remain explicit evidence for review and cannot be rescaled or adopted.

Reported dates are calendar objects with only the supplied components: `{year}`, `{year,month}` or
`{year,month,day}`. A cleared date is null. Reflection `""` is retained as an empty value; null is a clear. These
reported values do not replace or normalize `startedAt`, `completedAt` or `lastChangedAt`. The journal producer
does not deliver a separate journal audit timestamp, so the export does not invent one. Existing MAL row evidence
remains separately represented under `malEvidence`; the format does not claim an adoption link or infer a session
from provider evidence.

Retired occurrences remain excluded even though their private history remains available to account erasure.
Reopen, retirement, journal correction/clear, annotation edits, reviewed provenance changes, entry-incarnation
replacement and terminal account changes use the installed native source-fence and account lifecycle owners. A
changed source makes the original capture stale. Retries keep the same capture, expiry and opaque cursor operands;
they never adopt later edits or silently create a replacement.

## Coverage and omission notes

Version 1 retains its original fixed sections and has no annotation, provenance or journal coverage. Version 2 adds
those three independently counted sections; version 3 keeps that inventory and adds the journal assessment meaning.
All keep `fullExport:false`: other private account families and Commerce data remain unavailable. Source privacy does
not grant public permission. Provenance remains unsupported. See
[Personal archive annotation, journal and assessment recovery](library-archive-personal-fact-recovery.md).

The final version 2 and 3 manifests report row and UTF-8 record-byte totals for every declared section, including empty
sections. They appear only after the complete bounded traversal. Each returned page carries no more than 16 records;
each version 2 and 3 record is refused above 65,536 encoded bytes, page records are capped at 120,000 bytes, and the artifact stops
at 100,000 rows or 32 MiB. An unrepresentable supported row returns an explicit `limit` state without a partial
downloadable artifact. Capture lifetime remains fifteen minutes. Provider-evidence version 4 stays outside this
consumer until its exact receive contract is installed; this decoder refuses it.
