---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'implementation',
  'paths':
    [
      'apps/web/src/library/personal-anilist-import',
      'apps/web/src/library/personal-bangumi-import',
      'apps/web/src/library/personal-mal-import',
      'apps/web/src/library/personal-list-import.md',
      'apps/web/src/library/personal-anilist-import.md',
      'apps/web/src/library/personal-bangumi-import.md',
      'apps/web/src/library/personal-mal-import.md',
      'apps/web/src/library/rich-private-entry',
      'apps/web/src/library/private-diary',
      'docs/library-entry-provenance.md',
      'docs/library-entry-state-history.md',
      'docs/library-and-collections.md',
    ],
  'riskAreas': [],
  'criticalPath': false,
  'after':
    [
      '46c55ef1-fdd9-4da8-9b0e-c7d97dbd524a',
      '52899c3b-b1f7-4b58-939f-aa403e19e0c6',
      '9e07d83f-3ef7-4c9f-8a12-788022e6727a',
      '1e4e6f38-c0ef-4c56-b2ed-123dd6928ee3',
      '8375cd2f-0d50-41d6-8e32-f92f5720c012',
      '294e3e0a-600a-4ec9-aac6-266431cc6654',
    ],
  'waiting': [],
  'estimate': { 'lines': 700, 'files': 12 },
}
---

# Continue provider source admission and state-history receiving

Complete the remaining private-entry journey by wiring the existing AniList, Bangumi and MAL import review owners to
the installed generated `libraryEntries(...).sourceObservations.post` method. Preserve each provider's exact record
identity and bounded preview evidence. Require explicit confirmation of source privacy and original timestamps in
the existing provider confirmation flow. Submit source admission as its own typed command after the existing import
command; an uncertain admission retains its original sender, credentials, key and operands for exact retry and never
replays an accepted import. Keep values private, preserve unknown and partial meaning, and report unsupported
precision without fabricating dates or claiming a field was applied. Do not add a second parser or importer.

VNDB remains unavailable until its generated client methods are installed. The generated client in this base also
lacks the list, review and restore methods for private entry state history. Keep that surface explicitly unavailable
until the installed typed signatures and coverage contract are available; then add bounded keyset history, addressed
review and guarded restore through the native owner. Do not construct raw transport, cast substitute methods or
infer complete history from an empty page.

Add focused owner journey cases for the three existing importers, independent source identities, privacy and timestamp
precision, idempotent admission retry, terminal retirement and mobile/keyboard confirmation. Update the source and
state-history owner documents with exact installed limits and honest unavailable seams. Keep broad browser, growth,
native and acceptance checks under normal controller verification.
