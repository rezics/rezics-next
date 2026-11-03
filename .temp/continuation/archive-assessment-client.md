---
{
  'goal': 'commerce',
  'manager': 'commerce',
  'kind': 'implementation',
  'paths':
    [
      'packages/client/src/kernel/library*',
      'docs/library-archive-personal-fact-recovery.md',
      'docs/goals/library.capabilities.md',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'deletion', 'account'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'estimate': { 'lines': 80, 'files': 3 },
}
---

# Finish the generated assessment archive client handoff

The native V3 assessment archive route and recovery journey are installed. Finish the generated Kernel client handoff
when the existing Kernel declaration compiler errors are resolved. Use the actual client producer; do not hand-edit
generated declarations or add a handwritten client. Emit the current upload, preview, review, apply, result and
cancellation DTOs, including journal `reflection` and `assessment` choices and immutable
`reviewRevision/items` confirmation. Confirm the generated apply body matches the route, type-check `packages/client`,
and update the recovery contract and capability inventory. Canonical archive8bb/Web323 owns this handoff; Web318/142
retains the manual occurrence interface.

Acceptance: generated declarations expose the exact mounted route types and `bun run --cwd packages/client typecheck`
passes. Preserve unrelated generated declarations.
