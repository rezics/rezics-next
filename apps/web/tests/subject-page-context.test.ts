import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { fromPlainText } from '@rezics/document';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { SubjectPage, pageContext, type SubjectPageData } from '../src/features/pages/subject';
const subject = '00000000-0000-8000-8000-000000000010';
const page: SubjectPageData = {
  subject,
  profile: 'profile',
  template: { scope: 'generic', key: null },
  context: {
    id: '00000000-0000-8000-8000-000000000060',
    population: {
      kind: 'realm',
      id: '00000000-0000-8000-8000-000000000050',
      title: 'Kitchen readers',
    },
  },
  document: { root: { props: {} }, content: [{ type: 'ThreadList', props: { id: 'discussion', paged: true } }] },
  reads: {
    r0: {
      status: 200,
      body: {
        threads: [
          {
            id: 'thread-id',
            availability: 'available',
            title: 'Current discussion',
            firstPost: { availability: 'available', body: fromPlainText('Current opening post') },
          },
        ],
        next: 'opaque',
      },
    },
  },
};
const messages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Untitled',
  sources: 'Sources',
  aliases: 'Aliases',
  search: 'Search',
};
test('the selected Context renders actual current discussions and an empty scanned page honestly', () => {
  expect(planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads.r0).toMatchObject({
    kind: 'subjectThreads',
    place: page.context?.population.kind === 'realm' ? page.context.population.id : '',
  });
  const html = renderToString(createElement(SubjectPage, { page, locale: 'en', messages }));
  expect(html).toContain('Kitchen readers');
  expect(html).toContain('Current discussion');
  expect(html).toContain('Current opening post');
  const empty = { ...page, reads: { r0: { status: 200, body: { threads: [], next: 'opaque' } } } };
  const scanned = renderToString(createElement(SubjectPage, { page: empty, locale: 'en', messages }));
  expect(scanned).toContain('No visible entries on this page.');
});
