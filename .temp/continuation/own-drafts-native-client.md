---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'interface',
  'riskAreas': ['authorization', 'disclosure', 'account', 'deletion', 'rights'],
  'criticalPath': false,
  'after': ['97ee5f14-ddf2-419b-99ec-1a18f6e3e708'],
  'waiting': [],
  'paths':
    [
      'apps/web/src/threads/own-drafts/**',
      'apps/web/src/threads/composer*.tsx',
      'apps/web/src/routes/drafts.tsx',
      'apps/web/src/shell/navigation*',
      'apps/web/src/stories/own-drafts.stories.tsx',
      'apps/web/tests/own-drafts*.test.ts*',
      'apps/web/messages/*.json',
      'docs/goals/web.md',
    ],
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
          'tests/own-drafts-page.test.tsx',
          'tests/own-drafts-resume.test.tsx',
          'tests/own-drafts-commands.test.tsx',
        ],
      'placement': 'default',
      'tests':
        [
          'Bind the installed generated own-draft list and exact selected-read methods to a signed-in /drafts destination and existing account navigation; keep the route private, one-page, no-store and absent from persistent browser state.',
          'Resume the selected exact native post in InlinePostEditor with thread, post, revision, language, licence, Subjects and media intact. Keep browser-local writing independently named and require an explicit choice before adopting either body.',
          'Support only native-permitted save, publish and erase actions. Preserve exact uncertain command intent and explicit retry, inspect known conflicts, and confirm retained content, publication or erasure with supported current readback.',
          'Retire metadata, bodies, action advice, selection, retry material and delayed effects on account, credential/CSRF epoch, locale, source, cursor or revision replacement. Keep preparing, sparse continuation, concealed selection, unavailable, denied and empty distinct.',
          'Connect phone/desktop light/dark stories and keyboard focus behavior for ready, preparing, selected, conflict, uncertain command, erase review, denied and long-localized states. Preserve the 20-row page and one-body bounds without polling or hidden refill.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 1800, 'files': 18 },
}
---

# Finish the server-saved drafts journey

A signed-in person can open the localized Drafts destination, see the current bounded server inventory and inspect one exact draft privately. The selected native post resumes in the existing composer with its revision and writing context intact. Save, publish and erase use only current native permission advice, preserve exact uncertain intents for explicit retry, and explain acknowledgement separately from supported readback.

The browser-saved writing feature remains independent. Before adopting either source, the person sees which body came from the server and which came from this browser and explicitly chooses. Neither source silently replaces the other.

Bind the current generated Content client methods when their installed publication is available. Keep native action paths validated against the selected account/thread/post/revision and invoke only generated typed methods. Complete the account-to-writing visit, sparse continuation, stale and uncertain recovery, erasure confirmation, synchronous retirement, eight-locale copy, and mounted tests. Verify the documented 1/10/20 row and single selected-body bounds; Content retains native history-growth acceptance.
