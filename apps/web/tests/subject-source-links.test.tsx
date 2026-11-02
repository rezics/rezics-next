import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OverviewValue } from '../src/features/pages/overview';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const { SourcesSection } = await import('../src/features/pages/overview');
const require = createRequire(import.meta.url);
const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
const value: OverviewValue = {
  locale: 'en',
  subject: null,
  link: ({ href, children }) => <a href={href}>{children}</a>,
  reader: { spoilerLevel: 0, suitability: 'blur' },
  labels: {
    spoilerShow: 'Show',
    documentSpoiler: 'Spoiler',
    cover: { withheld: 'Withheld', reveal: 'Reveal', credit: 'Credit', via: 'Via' },
  },
  unlabelled: 'Unlabelled',
  spoilerShow: 'Show',
  details: 'Details',
  cover: 'Cover',
  coverVia: 'Via',
  licence: 'Licence',
  source: 'Source',
  sources: 'Sources',
  sections: new Map(),
  relations: {},
  relationNodes: [],
};

test.each([
  ['https://Archive.example.test:443/a%2Fb?edition=1&language=en#Credit', true],
  ['http://archive.example.test:8080/original#credit', true],
  ['', false],
  ['/relative', false],
  ['//archive.example.test/record', false],
  ['https://', false],
  ['javascript:alert(1)', false],
  ['data:text/html,credit', false],
  ['mailto:archive@example.test', false],
])('source and credit destinations preserve text and apply the external URL policy: %s', (url, linked) => {
  const window = new Window();
  try {
    window.document.body.innerHTML = renderToStaticMarkup(
      <SourcesSection
        value={value}
        sources={{
          credit: { rightsHolder: 'Cover Artist', via: { name: 'Cover Archive', url }, license: 'Cover permission' },
          records: [{ name: 'Original Archive', url, licence: { id: 'CC-BY-4.0', url }, attribution: '© Archive Curators' }],
          urls: [url],
          identifiers: [],
        }}
      />,
    );
    const anchors = [...window.document.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual(linked ? [url, url, url, url] : []);
    if (linked)
      expect(anchors.map((anchor) => anchor.textContent)).toEqual(['Cover Archive', 'Original Archive', 'CC-BY-4.0', url]);
    for (const text of [
      'Cover Artist', 'Cover Archive', 'Cover permission', 'Original Archive', 'Licence: CC-BY-4.0', '© Archive Curators',
    ])
      expect(window.document.body.textContent).toContain(text);
  } finally {
    window.close();
  }
});
