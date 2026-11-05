# Private annotation and occurrence journal export

The native owner API and artifact format are defined by [Personal Library export](library-export.md). This page
records how the delivered personal-entry and progress-session fields cross that boundary. It does not add another
export endpoint, archive store, importer, or Web page. Web323 remains the sole private export interface at
`/library/export`.

## Stored version 3 records

Stored version 3 captures keep version 2's independent `annotations`, `provenance` and `journals`
sections. Its `annotations` section includes one record for each retained personal
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
`progressRevision`, and separate native progress times. The nested `journal` uses
`{sessionId,revision,startDate,finishDate,reflection,assessment}`. Its revision is the journal-local revision; the
enclosing `progressRevision` is the independent occurrence revision. Assessment is
`{meaningRevision:1,units:number|null}`; units use the fixed 0–20 integer scale and display as `units / 2`. Null is
preserved as no current assessment, including an explicit clear.

Reported dates are calendar objects with only the supplied components: `{year}`, `{year,month}` or
`{year,month,day}`. A cleared date is null. Reflection `""` is retained as an empty value; null is a clear. These
reported values do not replace or normalize `startedAt`, `completedAt` or `lastChangedAt`. The journal producer
does not deliver a separate journal audit timestamp, so the export does not invent one. Existing MAL row evidence
remains separately represented under `malEvidence`; the format does not claim an adoption link or infer a session
from provider evidence.

New captures use version 4, which appends provider sections and preserves these assessment records. V3 remains a
supported completed artifact and is the only producer version with assessment records and no provider sections.

Retired occurrences remain excluded even though their private history remains available to account erasure.
Reopen, retirement, journal correction/clear, annotation edits, reviewed provenance changes, entry-incarnation
replacement and terminal account changes use the installed native source-fence and account lifecycle owners. A
changed source makes the original capture stale. Retries keep the same capture, expiry and opaque cursor operands;
they never adopt later edits or silently create a replacement.

## Coverage and omission notes

Version 1 retains its original fixed sections and has no annotation, provenance or journal coverage. Version 2 adds
those three independently counted sections with the earlier journal shape and no assessment field. Version 3 adds
assessment to each journal record while keeping the same fixed sections and `fullExport:false`. A missing assessment
in version 1 or 2 means that the archive predates this field; it is not an inferred null or a public vote. Other
private account families and Commerce data remain unavailable. It does not claim public permission from source
privacy. The existing archive recovery accepts V2 annotation and journal-date evidence and V3 journal assessments
through the native personal-fact journey. It accepts exact V1/V2/V3 manifests; V2 absence remains legacy absence, and
V3 values with unknown meaning revisions remain unsupported evidence. Provenance remains unsupported. See
[Personal archive annotation, journal and assessment recovery](library-archive-personal-fact-recovery.md).

Version 2 and 3 manifests report row and UTF-8 record-byte totals for every declared section, including empty
sections. They appear only after the complete bounded traversal. Each returned page carries no more than 16 records;
each version 2 or 3 record is refused above 65,536 encoded bytes, page records are capped at 120,000 bytes, and the
artifact stops at 100,000 rows or 32 MiB. An unrepresentable supported row returns an explicit `limit` state without
a partial downloadable artifact. Capture lifetime remains fifteen minutes.
