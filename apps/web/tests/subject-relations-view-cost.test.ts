import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { slug } from '@rezics/definitions/slug';
import { RelationsView } from '../src/features/pages/relations-view.tsx';
import { PlainLink } from '../src/features/pages/shared.tsx';
import { defaultReader } from '../src/subject/reader.ts';

const subject = '01a1740d-7480-71e4-841f-66c04022d7d0';
const row = (n: number) => `01a1740d-7480-71e4-841f-${String(n).padStart(12, '0')}`;
const labels = {
  spoilerShow: 'Show',
  documentSpoiler: 'Reveal',
  cover: { withheld: 'w', reveal: 'r', credit: 'c', via: 'v' },
};

/** One page of the inverse read: the page size is fixed, the count is whatever the in-degree is. */
function page(count: number) {
  return {
    links: Array.from({ length: 100 }, (_, index) => ({
      subject: row(index + 1),
      property: 'wdt:P155',
      statement: row(index + 2000),
      label: `Holder ${index + 1}`,
      type: 'schema:Book',
      summary: null,
    })),
    count: { value: count, exact: count <= 1_000 },
    next: 'opaque-cursor',
  };
}

const render = (count: number) =>
  renderToString(
    createElement(RelationsView, {
      locale: 'en',
      subject: { id: subject, label: 'The Little Prince' },
      title: 'The Little Prince',
      data: { body: page(count), property: null },
      relations: { 'wdt:P155': { label: 'Sequel', group: 'order', symmetric: false } },
      value: {
        locale: 'en',
        link: PlainLink,
        reader: defaultReader,
        labels,
        unlabelled: 'Unlabelled',
        spoilerShow: 'Show',
      },
    } as never),
  );

test('the relations view renders one page of the continuation however large the relation count grows', () => {
  const sizes = [100, 10_000, 1_000_000];
  const views = sizes.map(render);
  for (const html of views) {
    expect(html.match(/<article\b/g)).toHaveLength(100);
    expect(html).toContain(
      `href="/en/subjects/${subject}/${slug('The Little Prince')}/relations?cursor=opaque-cursor"`,
    );
  }
  expect(views[1]).toContain('10,000+ total');
  expect(views[2]).toContain('1,000,000+ total');
  // Rendering work follows the page size: ten thousand times the relations adds a few characters of count.
  expect(views[2]!.length - views[0]!.length).toBeLessThan(64);
});
