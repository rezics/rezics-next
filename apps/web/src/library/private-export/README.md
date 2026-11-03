# Web private Library export consumer guide

Web owns the signed-in `/library/export` visit. Commerce owns the capture, its source fence, authorization, expiry,
limits and native record meanings. The [native contract](../../../../docs/library-export.md) is authoritative for those
details.

Decision: new captures use version 3; stored version 1 and 2 captures keep their original sections, record shapes,
manifest fields, byte accounting and cursor epochs. Version 3 keeps the 17-section version 2 inventory and adds
`journal.assessment` with `meaningRevision: 1` and `units` from 0 through 20 or `null`. Missing assessment in a
stored version 1 or 2 journal remains absent.

## Versioned coverage

The installed `libraryExports` methods are the only transport. If a mounted method is absent or its response does not
match the generated contract, the visit stays unavailable. Web does not build a second export or fill gaps from other
private readers.

Version 1 remains the fixed historical coverage. It has no annotation, provenance or journal claims and no section
totals. Version 2 adds the `annotations`, `provenance` and `journals` sections and declares row and record-byte totals
for every section, including sections with zero rows. Version 3 retains that inventory and accounting while adding
the private journal assessment. Web keeps the native record fields and meanings intact.

- Annotations are independent owner facts. Their revision remains when note and priority are both cleared.
- Provenance keeps the accepted native provider and record IDs and preserves unknown, absent, cleared, private and
  source-visible values as distinct states. A source-visible choice does not publish this Library.
- Journals belong to live occurrence rows and keep their native occurrence/session IDs and independent journal and
  progress revisions. Partial dates remain partial, cleared dates remain `null`, and empty reflections remain
  distinct from `null`. Web does not infer an import-to-journal link.
- Archive recovery supports versions 1 and 2 only. Version 3 assessments and version 4 provider evidence are not
  recoverable. Downloaded evidence does not set votes, journals, labels or progress.

Provider evidence from VNDB and AniList is unavailable until the native owner publishes an exact version 4 manifest,
coverage, section order, cursor epoch and generated request. Web refuses unsupported installed versions; adding provider
sections under version 3 does not create a compatible capture. Version 4 recovery remains unsupported until native
consumers admit it.

## Capture and local file

The person starts a capture explicitly. Web binds every page and final manifest to the original capture ID, version,
coverage, timestamps, sections and fifteen-minute expiry. It continues through empty intermediate pages, but rejects
mixed captures, unsupported versions, malformed terminal pages and any mismatch between assembled records and the
native totals.

Pages contain at most sixteen records and 120,000 encoded record bytes. Version 2 and 3 records are at most 65,536
encoded bytes; the stream stops at 100,000 records or 32 MiB of record bytes. Cursors are at most 4,096 characters.
Version 1, 2 and 3 cursor epochs remain separate. Native work is `K + C + R`: K returned pages (including empty
continuations), fixed create/status/cancel calls C and explicit retries R. Assembly is O(N+B), with retained memory
bounded by record bytes, final framing and manifest, plus one page. Final serialization uses one bounded JSON string
and one encoded byte buffer.

No partial, stale, limited, expired, cancelled or unfinished stream offers a file. A failed local save retries the
same completed bytes. If those bytes are lost, replay starts from the original cursor under the same capture. Cancel,
unmount and viewer or CSRF replacement clear private state and ignore late results. Private bytes stay in visit
memory and the local file; they do not enter URLs, persistent browser storage or shared caches.
