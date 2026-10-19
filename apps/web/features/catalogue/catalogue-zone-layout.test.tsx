import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { ZoneBrowse } from '../zones/browse.tsx';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { officialBrowseModel, officialZone } from '../zones/official-fixtures.ts';
import { cardRenderer } from '../zones/zone-home.tsx';

const zone = officialZone('books', 'en');
const messages = zoneMessagesFor('en');
const card = cardRenderer(zone, null, 'en', messages);

test.each(['grid', 'list'])('Zone %s keeps the complete received page in order and its continuation before hydration', view => {
  const page = officialBrowseModel('books', 'en', { view });
  const model = { ...page, next: `${zone.links.browse}?view=${view}&cursor=opaque-next`,
    first: `${zone.links.browse}?view=${view}` };
  const html = renderToString(<ZoneBrowse model={model} messages={messages} card={card} />);
  const headings = [...html.matchAll(/<h3\b[^>]*>(.*?)<\/h3>/gsu)]
    .map(match => match[1]!).filter(heading => heading.includes('href='));
  expect(headings).toHaveLength(page.items.length);
  page.items.forEach((work, index) => {
    expect(headings[index]).toContain(renderToString(<>{work.title!.value}</>));
    expect(html).toContain(renderToString(<>{work.author!.value}</>));
    expect(html).toContain(work.href);
  });
  expect(html).toContain(model.next.replaceAll('&', '&amp;'));
  expect(html).toContain(model.first.replaceAll('&', '&amp;'));
  expect(html).toContain(messages.next);
});

test('a single Zone search result retains its title, author and book proportions', () => {
  const model = officialBrowseModel('books', 'en', { view: 'grid', q: 'Jane Eyre' });
  expect(model.items).toHaveLength(1);
  const html = renderToString(<ZoneBrowse model={model} messages={messages} card={card} />);
  expect(html.match(/<article\b/gu)).toHaveLength(1);
  expect(html).toContain('Jane Eyre');
  expect(html).toContain('Charlotte Brontë');
  expect(html).toContain('data-kind="book"');
  expect(html).toContain('aspect-ratio:0.6666666666666666');
});
