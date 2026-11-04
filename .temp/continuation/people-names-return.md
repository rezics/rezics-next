---
{
  'goal': 'semantic',
  'manager': 'semantic',
  'kind': 'implementation',
  'paths':
    [
      'apps/web/src/features/catalogue/people-names/**',
      'apps/web/tests/people-names*.test.ts',
      'apps/web/tests/people-names*.test.tsx',
      'apps/web/src/stories/people-names*.stories.tsx',
      'apps/web/messages/*.json',
      'docs/subject-pages.md',
    ],
  'riskAreas': ['authorization', 'disclosure', 'rights', 'deletion', 'account'],
  'criticalPath': false,
  'after': [],
  'waiting': [],
  'acceptance':
    {
      'tests':
        [
          'A visitor follows existing Terms or Sources from a Person or Character names group and returns with the exact same-locale Subject, supplied Context/Realm, filter, local window and safe focus target through the shared names-return handoff.',
          'Modified clicks retain normal link behavior. An unsafe or retired deep return offers an honest return to the exact names section. Subject, Context, locale, release, reader and source-incarnation replacement permanently retire old return callbacks, including A-B-A; private Terms drafts and exact command recovery remain independent.',
          'Mounted exact-return and retirement cases, plus shared bounded composition acceptance at 64/512/4096 unrelated Subjects/history; preserve current work-title outcomes and distinguish fixture composition from native acceptance.',
        ],
      'failing': true,
    },
  'estimate': { 'lines': 650, 'files': 6 },
}
---

# Return from Terms or Sources to the exact Person or Character names visit

Use [the supplied-names owner contract](../../docs/subject-pages.md#person-and-character-supplied-names) and
`apps/web/src/features/catalogue/people-names/{entry,view,model}.ts*`.
The people view already uses the shared `work-names/model.ts` producer, bounded language/name windows, local search,
exact copy, source-fenced callbacks and the existing bounded Terms advice read. Keep that public mounting and all
independent profile facts. No new terms reader, language scanner, route or observation registry is needed.

The bound base's work-title owner section explicitly retains the shared Terms return/focus handoff as a continuation;
there is no names-return visit helper in `work-names/**` yet. Build against that shared handoff's documented contract
or a minimal shared seam when available. Its work-name owner retains work-names and shared Terms/navigation changes;
do not clone the work return reducer into the people feature. The names view currently uses its existing page link
adapter to preserve supplied Context/Realm on the ordinary Terms and Sources destinations and makes no exact-return
promise. Complete the missing user journey without changing the Terms editor's authentic original read, candidate
payload, independent private draft or command recovery.

Retain one bounded return state and charge its UTF-8 URL/state bytes separately from the existing 262,144-byte
projection, local filter memory and at most 192 mounted name rows. A normal visit can return to its originating group,
filter and name control. If exact deep return cannot be admitted, expose a truthful link to this Subject's exact
supplied-names section. Never restore a former private editor or infer permission from public expansion. Add focused
mounted return and A-B-A cases to the existing tests, preserving their signed-out, advice, overflow and clipboard
coverage. Broader native and browser acceptance remains the controller's integration responsibility.
