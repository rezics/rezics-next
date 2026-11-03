import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnClassificationsWorkspace } from '../src/ratings/own-classifications/page';
import { classificationFrontier, classificationSearch } from '../src/ratings/own-classifications/inventory';
import { accountId, associationId, classificationsPage, subjectId } from './own-classification-assessments-fixture';
import { libraryNavigation } from '../src/library/navigation';
import { operationIsAdmitted } from '../src/kernel/exposure';

test('sparse continuation preserves opaque bytes and selected binding without suggesting complete history', () => {
  const address = { cursor: ' raw +/=%opaque ', selectedSubjectId: subjectId, selectedAssociationId: associationId };
  const frontier = classificationFrontier(address)!;
  expect(classificationSearch(frontier)).toEqual(address);
  const html = renderToStaticMarkup(
    <OwnClassificationsWorkspace
      state="ready"
      page={classificationsPage([], 'next raw')}
      frontier={frontier}
      locale="en"
      isCurrent={() => true}
      onRetry={async () => {}}
      onNext={() => {}}
    />,
  );
  expect(html).toContain('More retained slots may follow.');
  expect(html).toContain('Next page');
  expect(html).not.toContain('No retained assessments are disclosed on this page.');
  expect(html).not.toContain(accountId);
  const contribution = libraryNavigation.find((entry) => entry.id === 'library.own-classifications')!;
  expect(contribution).toMatchObject({
    signedIn: true,
    href: '/library/classification-assessments',
    operation: 'classification_ballot.own_page',
  });
  expect(operationIsAdmitted('classification_ballot.own_page', ['personal_library'])).toBe(true);
  expect(operationIsAdmitted('classification_ballot.own_page', [])).toBe(false);
});

test('revoked, moved-home, stale and dependency-unavailable never render previous account rows', () => {
  for (const state of ['denied', 'signed-out', 'moved-home', 'stale-continuation', 'unavailable'] as const) {
    const html = renderToStaticMarkup(
      <OwnClassificationsWorkspace
        state={state}
        page={classificationsPage()}
        frontier={{ cursor: 'original', selected: null }}
        locale="en"
        isCurrent={() => true}
        onRetry={async () => {}}
        onNext={() => {}}
      />,
    );
    expect(html).not.toContain('Own-page subject');
    expect(html).not.toContain('Next page');
    expect(html.includes('Retry this page')).toBe(state === 'unavailable');
  }
});
