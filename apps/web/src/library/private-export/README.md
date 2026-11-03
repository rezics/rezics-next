# Web private Library export consumer guide

Web owns the signed-in `/library/export` visit. Commerce owns the capture, its source fence, authorization, expiry,
limits and native record meanings. The [native contract](../../../../docs/library-export.md) is authoritative for those
details.

Decision: new captures use version 2; stored version 1 captures keep their fourteen sections, original manifest
fields and exact cursors.

## Versioned coverage

The installed `libraryExports` methods are the only transport. If a mounted method is absent or its response does not
match the generated contract, the visit stays unavailable. Web does not build a second export or fill gaps from other
private readers.

Version 1 remains the fixed historical coverage. It has no annotation, provenance or journal claims and no section
totals. Version 2 adds the `annotations`, `provenance` and `journals` sections and declares row and record-byte totals
for every section, including sections with zero rows. Web keeps the native record fields and meanings intact.

- Annotations are independent owner facts. Their revision remains when note and priority are both cleared.
- Provenance keeps the accepted native provider and record IDs and preserves unknown, absent, cleared, private and
  source-visible values as distinct states. A source-visible choice does not publish this Library.
- Journals belong to live occurrence rows and keep their native occurrence/session IDs and independent journal and
  progress revisions. Partial dates remain partial, cleared dates remain `null`, and empty reflections remain
  distinct from `null`. Web does not infer an import-to-journal link.
- Archive recovery accepts version 1 only. Version 2 files and their three added sections are not recoverable or
  reimportable.

## Capture and local file

The person starts a capture explicitly. Web binds every page and final manifest to the original capture ID, version,
coverage, timestamps, sections and fifteen-minute expiry. It continues through empty intermediate pages, but rejects
mixed captures, unsupported versions, malformed terminal pages and any mismatch between assembled records and the
native totals.

Pages contain at most sixteen records and 120,000 encoded record bytes. Version 2 records are at most 65,536 encoded
bytes; the stream stops at 100,000 records or 32 MiB of record bytes. Cursors are at most 4,096 characters. Records
stay in bounded page chunks; Web serializes one complete `{manifest,records}` file after the final verified manifest.
Work is O(N+B), with retained memory bounded by the record bytes, final framing and manifest, plus one page. Final
serialization uses one bounded JSON string and one encoded byte buffer.

No partial, stale, limited, expired, cancelled or unfinished stream offers a file. A failed local save retries the
same completed bytes. If those bytes are lost, replay starts from the original cursor under the same capture. Cancel,
unmount and viewer or CSRF replacement clear private state and ignore late results. Private bytes stay in visit
memory and the local file; they do not enter URLs, persistent browser storage or shared caches.
