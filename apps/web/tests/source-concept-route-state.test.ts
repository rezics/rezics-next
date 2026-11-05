import { expect, mock, test } from 'bun:test';
import { conceptWorksRouteFor, patchConceptWorksSearch } from '../src/features/pages/source-concept-reading/works-route';
import { encodeConceptVisitDescriptor, parseConceptHierarchyAddress } from '../src/features/pages/source-concept-reading/navigation';
import type { ConceptVisitDescriptor } from '../src/features/pages/source-concept-reading/navigation';

mock.module('cloudflare:workers', () => ({ env: {} }));
const visit: ConceptVisitDescriptor = {
  version: 1,
  subject: '00000000-0000-4000-8000-000000000001',
  role: 'rezics:conceptTag',
  current: { release: `sha256:${'a'.repeat(64)}`, revision: 1, context: '00000000-0000-4000-8000-000000000002', type: 'skos:Concept' },
  addresses: [null, 'original-hierarchy-cursor'], index: 1, truncated: false, focus: { section: 'works' },
  works: {
    property: 'rezics:conceptTag', scheme: '00000000-0000-4000-8000-000000000003',
    type: 'rezics:VisualNovel', includeChildren: true, spoilerThreshold: 2,
    conditionText: JSON.stringify({ kind: { in: ['rezics:VisualNovel'] } }),
    tagQualifiersText: JSON.stringify([{ property: 'rezics:tagWeight', gte: '1' }]),
  },
};

test('the mounted route resumes descendants and clears filters without resurrecting saved works', async () => {
  const { Route } = await import('../src/routes/subjects/$id_.$slug.concepts');
  const validate = Route.options.validateSearch as (search: Record<string, unknown>) => Record<string, unknown>;
  const initial = validate({ conceptVisit: encodeConceptVisitDescriptor(visit) });
  const selected = conceptWorksRouteFor(initial, visit);
  expect(selected).toMatchObject(visit.works);
  const changed = patchConceptWorksSearch(initial, {
    includeChildren: false, spoilerThreshold: 0, condition: undefined, tagQualifiersText: undefined,
    type: undefined, sort: 'rating', cursor: undefined,
  }, visit);
  const returned = conceptWorksRouteFor(validate(changed), undefined);
  expect(returned).toMatchObject({ property: visit.works.property, scheme: visit.works.scheme, sort: 'rating' });
  for (const key of ['includeChildren', 'spoilerThreshold', 'conditionText', 'tagQualifiersText', 'type'])
    expect(returned[key as keyof typeof returned]).toBeUndefined();
  expect(changed.conceptVisit).toBeUndefined();
  expect(parseConceptHierarchyAddress(changed.hierarchy)).toMatchObject({ subject: visit.subject, addresses: visit.addresses, index: 1 });
  expect(changed.role).toBe(visit.role);
});

test('editing a child keeps its parent return and unrelated route state', () => {
  const parentReturn = encodeConceptVisitDescriptor(visit);
  expect(patchConceptWorksSearch({ conceptVisit: parentReturn, returnTo: '/en/subjects/work/label', cursor: 'works-page-2' }, { sort: 'name' }, undefined))
    .toMatchObject({ conceptVisit: parentReturn, returnTo: '/en/subjects/work/label', cursor: 'works-page-2', sort: 'name' });
});
