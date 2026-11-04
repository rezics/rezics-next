---
{
  'goal': 'content',
  'manager': 'content',
  'kind': 'claim',
  'paths':
    [
      'apps/web/src/features/pages/subject-community*.ts',
      'apps/web/src/features/pages/subject-community*.tsx',
      'apps/web/src/features/pages/subject-community-entry/**',
      'apps/web/src/features/pages/overview.tsx',
      'apps/web/src/features/pages/subject-visit-navigation.ts',
      'apps/web/tests/subject-community*.test.*',
      'apps/web/src/stories/subject-community*.tsx',
      'apps/web/messages/*.json',
      'apps/web/src/routes/boards/$id.tsx',
      'apps/web/src/routes/boards/$id_.new.tsx',
      'apps/web/src/threads/board-community-actions.tsx',
      'apps/web/src/threads/thread-creation-lifetime.ts',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'deletion', 'account'],
  'waiting': [],
  'after': [],
  'estimate': { 'lines': 2200, 'files': 16 },
  'criticalPath': false,
  'acceptance':
    {
      'tests':
        [
          'Subject community exact selected Board entry/creation states for work, character and person: not_selected, concealed, unavailable, current denied, sign-in and allowed; no inferred Board.',
          'Mounted entry/return journey retains original Subject/place, cursor/context/source/Realm revision, duplicate occurrences and current regional return through Board/composer/sign-in; existing Subject community baseline remains.',
        ],
    },
}
---

Finish the typed receiver after the sole serial publisher installs the official `KernelClient` output for the existing closed `SubjectThreadsQuerySchema` and `SubjectThreadsResponseSchema`. The publisher request for optional query `board` and response `entry` has already been sent to Goal `3ed6bf23`. Do not edit generated output, add a second producer, introduce local DTOs or casts, or infer permission from Board visibility.

Complete the browser journey using the existing Context → CommunityList → SubjectCommunityRegion placement and the current regional Board/composer/sign-in return seam. Receive the original native request and supplied Board identity plus closed creation advice. Show entry only from current advice; preserve `not_selected`; render allowed, current denied, concealed, unavailable, sign-in, and source-change retry states without disclosing hidden Board facts. Keep native commands authoritative and reauthorizing. Preserve the original request/context/source epoch and position, Realm head revision, duplicate row identity, and return visit through refresh, empty/sparse/failed continuation, signed-out, and changed-advice states.

Keep existing discussion cards and route ownership. Add only focused tests for the stated visible states and mounted journey; keep all existing Subject community behavior. The current web-to-Board/composer/sign-in return seam is already implemented in this worktree; adapt it only if the actual installed publisher contract requires it.
