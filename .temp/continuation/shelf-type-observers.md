---
{
  'goal': 'commerce',
  'manager': 'commerce',
  'kind': 'implementation',
  'paths':
    [
      'services/kernel/src/library/shelf-type-source.ts',
      'services/kernel/src/library/shelf-maintenance-runtime.ts',
      'services/kernel/test/library/support/native-shelf-type-pause.ts',
      'services/kernel/test/library/support/outcome-driver.ts',
      'services/kernel/test/library/native-shelf-type-pause.test.ts',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'account', 'deletion'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'estimate': { 'lines': 650, 'files': 5 },
  'acceptance':
    [
      'Real sync/sourceObserved and verify/entryObserved or sourceObserved pauses reach their installed production observations, returning the actual source stamp and entry incarnation.',
      'Selected operations release checkouts before waiting; resume and exceptPaused settlement isolate the selected execution, and close/error releases all latches.',
      'Preserve the entry observer and frozen stale-type and recreated-incarnation cases; run focused native-shelf-type-pause tests under the current launch policy.',
    ],
}
---

# Bind remaining shelf projection observation boundaries

The entry/sourceObserved binding is implemented through the installed entry preparation path. Keep its optional dependency and per-world one-shot request latches.

The current production module still has throwing declarations rather than installed producers for `syncShelfSubjectType(change: ShelfTypeChange, dependencies: ShelfProjectionDependencies)` and `verifyShelfEntryType(eventId: string, accountId: string, subjectId: string, dependencies: ShelfProjectionDependencies)` in `services/kernel/src/library/shelf-contract.ts`. The Library work module does not register the corresponding `library.shelfTypeSync` subject.revised/subject.merged and `library.shelfTypeVerify` entry.updated consumers. These are the exact remaining external interfaces. Do not simulate their observations or fabricate projection state.

Once those producers are installed, bind narrow optional observations at their actual released-checkout boundaries. Return the source identity and stamp actually read, and the observed entry incarnation at the verify boundary. Use per-execution worker communication so resume releases only that selected execution and exceptPaused settlement drains unrelated genuine DBOS work. Keep dispatch, maintenance identities, native currentness/CAS checks and replay behavior intact; add no continuation dispatch.

Consume the installed native shelf type fixture's real changeSubjectType/redeliver methods without duplicating the semantic writer. Preserve digest collision and growth bindings, all frozen assertions and Members behavior. Always release armed and held latches on close or error, and keep worlds isolated.
