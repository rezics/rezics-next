# Private annotation and occurrence journal export

The native owner API and artifact format are defined by [Personal Library export](library-export.md). This page
records how the delivered personal-entry and progress-session fields cross that boundary. It does not add another
export endpoint, archive store, importer, or Web page. Web323 remains the sole private export interface at
`/library/export`.

## Version 2 records

New captures use format version 2. Its `annotations` section includes one record for each retained personal
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

The `journals` section contains one record for each non-retired occurrence whose journal revision is greater than
zero. It keeps the owner, `sessionId`, Subject/version identity, occurrence state, original `libraryProfilePin`,
`progressRevision`, and separate native progress times. The nested `journal` uses the delivered shape
`{sessionId,revision,startDate,finishDate,reflection}`. Its revision is the journal-local revision; the enclosing
`progressRevision` is the independent occurrence revision.

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
those three independently counted sections while keeping `fullExport:false`: other private account families and
Commerce data remain unavailable. It does not claim public permission from source privacy. The version 1
existing archive recovery accepts V2 annotation and journal-date evidence through the native personal-fact journey;
provenance remains unsupported. See [Personal archive annotation and journal recovery](library-archive-personal-fact-recovery.md).

The final version 2 manifest reports row and UTF-8 record-byte totals for every declared section, including empty
sections. It appears only after the complete bounded traversal. Each returned page carries no more than 16 records;
each version 2 record is refused above 65,536 encoded bytes, page records are capped at 120,000 bytes, and the artifact stops
at 100,000 rows or 32 MiB. An unrepresentable supported row returns an explicit `limit` state without a partial
downloadable artifact. Capture lifetime remains fifteen minutes.
