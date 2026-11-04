---
{
  'goal': 'commerce',
  'manager': 'commerce',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/library/copy-list-context*',
      'services/kernel/src/library/personal-routes.ts',
      'services/kernel/src/library/README.md',
      'services/kernel/test/library/copy-list-context*',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'account', 'deletion'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'estimate': { 'lines': 500, 'files': 6 },
  'acceptance':
    {
      'tests':
        [
          'A FULL Copies page returns only complete, currently disclosed canonical Work identities for explicit edition associations, preserving scope, withheld, missing, unsupported and unavailable distinctions.',
          'Copies retain their original IDs, source pins and native editing authority across Semantic association movement and unavailable states, without hidden target disclosure or per-copy hydration.',
        ],
      'failing': true,
      'workerOwned': true,
    },
}
---

Complete the positive Work association after Semantic delivers the bounded completeness-aware batch read requested by Commerce. The current native producer deliberately reports `unsupported` for the association and already returns selected current facts, exact native copy rows, hidden-safe summaries, and bounded unavailable behavior. Extend the existing helper and FULL Copies response with the supplier's exact original-keyed state and canonical Work identity shape; do not infer from partial relation facts or add a local association cache. Add positive same-title Work, absent association, withheld-target, merge/currentness race and identity-preservation cases. Preserve BASIC behavior, private copy fields, source admission, exact copy pins and existing command ownership. Update the Library contract and provide the Web receiver the final DTO only after the supplier contract is installed.
