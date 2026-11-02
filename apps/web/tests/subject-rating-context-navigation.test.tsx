import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageData } from '../src/features/pages/data';
import { RatingsContext, RatingsSection, RatingsView } from '../src/features/pages/subject-ratings-view';
import { subjectViewHref } from '../src/subject/subject-href';

test('rating review and page retry links retain only the admitted localized Subject, view and exact Realm', () => {
  const subject = '00000000-0000-8000-8000-000000000010', locale = 'de', label = 'Les lectures';
  for (const view of ['overview', 'reviews'] as const) {
    for (const realm of [undefined, '00000000-0000-8000-8000-000000000050', '00000000-0000-8000-8000-000000000051']) {
      for (const unavailable of [false, true]) {
        for (const section of [false, true]) {
          const data = unavailable ? null : {
            question: { kind: 'absent' }, figure: { kind: 'absent' },
            global: { kind: 'absent' }, statistics: { kind: 'absent' },
          } as const;
          const html = renderToStaticMarkup(
            <PageData locale={locale} subject={subject} subjectLabel={label} realm={realm}
              pageTarget={{ subject, view, ...(realm ? { realm } : {}) }}
              context={{ id: 'global-context', population: { kind: 'global' } }}
              document={{ root: { props: {} }, content: [] }} reads={{}}
              messages={{ unknown: 'Unknown', none: 'None', unlabelled: 'Untitled', sources: 'Sources', aliases: 'Aliases', search: 'Search' }}>
              <RatingsContext.Provider value={data}>
                {section ? <RatingsSection id="ratings" subject={subject} locale={locale} /> :
                  <RatingsView data={data} id="ratings" subject={subject} locale={locale} />}
              </RatingsContext.Provider>
            </PageData>,
          );
          const href = (targetView: string) => subjectViewHref({ id: subject, label }, locale, targetView,
            realm ? `?realm=${realm}` : '');
          expect(html).toContain(`href="${href('reviews')}"`);
          if (unavailable) {
            expect(html).toContain('data-state="failed"');
            expect(html).toContain(`data-slot="retry" href="${href(view)}"`);
          }
        }
      }
    }
  }
});
