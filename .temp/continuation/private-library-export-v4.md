---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'interface',
  'riskAreas': ['authorization', 'disclosure', 'account', 'deletion', 'rights'],
  'criticalPath': false,
  'waiting': [],
  'paths':
    [
      'apps/web/src/library/private-export/**',
      'apps/web/src/stories/private-library-export*.stories.tsx',
      'apps/web/tests/private-library-export.test.tsx',
      'apps/web/messages/*.json',
      'docs/goals/web.md',
    ],
  'after':
    [
      'a4b71894-1b13-45dc-94df-bc04bed40f43',
      'd8fd34d8-7501-4d54-9830-b68d0d1461cc',
      '194dff87-02a0-484b-8d4a-29b33d8743db',
    ],
  'estimate': { 'lines': 450, 'files': 12 },
  'acceptance':
    {
      'command':
        [
          'bun',
          'apps/web/scripts/focused.ts',
          '--private-network',
          '--',
          'bun',
          'test',
          'tests/private-library-export.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          "The corrected V4 producer and installed generated request admit four provider evidence sections after V3's exact 17-section assessment inventory, with their own coverage, manifest and cursor epoch, all section totals and exact final artifact bytes.",
          'Stored V1, V2 and V3 captures retain their original sections, cursors, bytes, and assessment absence/null/zero semantics; malformed or mixed terminal manifests cannot create a file.',
          'V4 evidence stays private and inert, offers no vote, journal, label or progress action, and remains unsupported by recovery until native consumers admit it.',
          'Unknown create, exact page retry, failed local save retry, source invalidation, expiry and viewer or credential retirement preserve intent and clear incomplete private bytes.',
        ],
      'failing': true,
    },
}
---

## Remaining outcome

Complete Web V4 support after Commerce publishes the corrected provider exporter and the installed generated request
with its exact V4 section order, manifest, coverage, cursor epoch, byte bounds and real page examples. Keep V3 bound to
the 17-section assessment inventory. Admit V4 only from the published contract, preserve provider records byte for
byte, and show that downloading them does not change votes, journals, labels or progress. Keep recovery unavailable
until native consumers explicitly admit V4. Extend the same mounted journey, locale messages, connected stories and
focused tests using actual producer artifacts; do not infer field names or use a source that appends provider sections
to V3.
