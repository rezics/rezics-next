---
{
  'goal': 'web',
  'manager': 'web',
  'kind': 'interface',
  'riskAreas': ['authorization', 'disclosure', 'rights', 'account', 'deletion'],
  'criticalPath': false,
  'after':
    [
      'eda59d58-d2b6-4674-a92c-3b5cc345c2cb',
      'fde5a113-246b-4aff-a56c-f209ac6c5a5e',
      '59999de4-4f17-4643-af4f-cfeb177771b2',
    ],
  'waiting': [],
  'paths':
    [
      'apps/web/src/ratings/own-votes/**',
      'apps/web/src/routes/library/ratings.tsx',
      'apps/web/src/stories/own-votes.stories.tsx',
      'apps/web/tests/own-votes-*.test.ts*',
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
          'tests/own-votes-inventory.test.ts',
          'tests/own-votes-commands.test.ts',
          'tests/own-votes-current-reader.test.tsx',
          'tests/own-votes-journey.test.tsx',
        ],
      'placement': 'default',
      'failing': true,
      'tests':
        [
          'An admitted readable zero or nonzero vote with unavailable/read_only advice explains the current limitation without edit, clear or fabricated action links; a fresh admitted editable row can be selected explicitly.',
          'Populated, empty, concealed sparse continuation, dependency failure, revoked access and identical-cursor retry preserve their distinct native outcomes in the existing mounted account visit.',
          'Replacing an editable row with read-only advice retires its form and delayed write/readback effects; an uncertain original command is never rewritten or treated as confirmed from newer current data.',
          'The native twenty-row bound, original pair identity, same-intent replay, account/session/exposure retirement and zero per-row hydration remain intact.',
        ],
    },
  'estimate': { 'lines': 450, 'files': 9 },
}
---

# Bind My ratings to the published generated reader

Continue the existing `/library/ratings` visit after Content publishes the exact generated `GET /v1/me/rating-votes` request and response types in the installed `@rezics/client`. The current base has the producer route and `createOwnVotesReader`, but the generated client publication is absent. Keep the existing server-only adapter until the generated replacement is installed. Do not add a raw endpoint, client cast, hand-edited declaration, alternate writer, publisher, or capture campaign.

Bind the generated request to the current account admission and mount one producer-backed visit: inspect an original question/target pair, show its native advice, make an admitted change or clear, replay an uncertain command with its frozen identity, separately inspect supported readback, open an admitted Subject, and return to a fresh page at the same frontier. Add the named response/currentness replacement and delayed-readback story states using actual native recordings when delivered. Keep source exports, installed publication, executed native acceptance, and rendered verification as separate evidence; controller owns native, growth, and rendered checks.

Preserve zero and absence, read-only and unavailable advice, retired clear, sparse continuation, revoked access, exact-cursor retry, original pair identity, the twenty-row bound, O(N) indexing, O(1) selection, and all current account/session/exposure/locale/source retirement and focus behavior. Update the adjacent My ratings guide and Web Goal when the generated binding is delivered. The current owner documents are [My ratings](../../apps/web/src/ratings/own-votes/README.md) and [Web Goal](../../docs/goals/web.md).
