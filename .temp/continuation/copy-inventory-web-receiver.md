---
{
  'goal': 'commerce',
  'manager': 'commerce',
  'kind': 'implementation',
  'paths':
    [
      'apps/web/src/library/copies-*',
      'apps/web/src/library/copy-inventory*',
      'apps/web/src/routes/library/copies*',
      'apps/web/test/library/copy-inventory*',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'account', 'deletion'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'estimate': { 'lines': 520, 'files': 8 },
  'acceptance':
    {
      'tests':
        [
          'Native kind/status choices and current allowed actions render on the existing Copies page using the published typed GET /v1/copies contract.',
          'Address parsing, active filters, reset, reload/back navigation, exact Subject context, selection/detail/draft origin and account/query-bound cursors work without changing copy or loan command authority.',
          'The installed current-read envelope preserves sessionSubject, requested address, current-reader CSRF provenance and invalid-cursor recovery; account replacement and late old-filter responses are discarded.',
        ],
      'failing': true,
      'workerOwned': true,
    },
}
---

# Finish the existing Copies receiving flow

The native `GET /v1/copies` producer now accepts optional exact `kind` and `status` IDs alongside `subjectId`, and
supports every predicate tuple before keyset paging. The response keeps `copies` and `next` and adds `filterOptions`:

```ts
{
  kinds: {
    state: 'available' | 'unavailable';
    choices: { id: string; label: string; labelLanguage?: string; meaning: 'available' | 'unsupported' | 'unavailable' }[];
  };
  statuses: {
    state: 'available' | 'unavailable';
    choices: { id: string; label: string; labelLanguage?: string; meaning: 'available' | 'unsupported' | 'unavailable' }[];
  };
}
```

The generated declaration still needs publication by the Content owner. Its current root exports are `KernelClient` and
`createKernelClient`; the checked-in GET typing only has `view`, `cursor`, `limit` and `subjectId`, with `{ copies,
next }`. The current package source also references the missing `./kernel/rating/own-votes-counted` module. The Content
handoff requested the precise query, response and generated typing update; do not add a local declaration or bypass the
typed client. Implement the Web receiver once that published typing is installed.

Native source head at handoff: `421ae50bc334e8d64b1fb279624868a44e1789f5`. The stale generated route declaration is at
`3c8649474435786d59176800053cc3888458a8fb`; the client root export source was last changed at
`7f71e1e858a2d18fd4e554fdd172e6a7198f939e`. No updated generated declaration head is available yet. Native cursors
bind account lifetime, requesting actor, route, full Subject/kind/status tuple, order and partition epoch. Filter
choices use the earliest retained copy's exact profile pin and distinguish unavailable meaning from unsupported IDs
and empty vocabularies. The endpoint runs under the existing admitted reader and shared request deadline, with a
second owner snapshot after bounded profile-label reads. Keep copy edit/delete/restore and loan actions on their exact
existing commands and operands, revision and key.

Complete the existing address parser, filters, active-filter/reset controls and reload/back behavior. Predicate changes
restart the cursor while retaining exact Subject context. Preserve current detail/selection/draft origin and drop old
results after account or query retirement. Keep `sessionSubject`, requested address, current-reader CSRF provenance and
invalid-cursor recovery association from the installed current-read envelope. Add receiving tests for account
replacement, a late response after filter navigation, exact Subject plus kind/status, empty versus unsupported versus
preparing state, malformed filters and cursor binding. The native 64/512/4096 growth case is authored and remains for
the controller's native gate; do not restart or duplicate it.
