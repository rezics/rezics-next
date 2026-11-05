import { expect, test } from 'bun:test';
import { Link } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubjectLink } from '../src/features/pages/route-support';

test('SubjectLink keeps malformed and unrecognized addresses readable while routing decoded Unicode canonically', () => {
  const valid = SubjectLink({
    href: '/zh-Hant/subjects/subject-1/%E6%9C%AC',
    lang: 'zh-Hant',
    children: 'Unicode subject',
  });
  const html = renderToStaticMarkup(
    <main>
      <SubjectLink href="/zh-Hant/subjects/bad%/book" lang="zh-Hant" className="subject-link">
        Malformed subject
      </SubjectLink>
      <SubjectLink href="/zh-Hant/subjects/subject-1/book?view=details#overview" lang="zh-Hant">
        Unrecognized subject
      </SubjectLink>
      <p>Surrounding page</p>
    </main>,
  );
  expect(valid).toMatchObject({
    type: Link,
    props: { to: '/subjects/$id/$slug', params: { id: 'subject-1', slug: '本' }, lang: 'zh-Hant' },
  });
  expect(html).toContain(
    '<a href="/zh-Hant/subjects/bad%/book" lang="zh-Hant" class="subject-link">Malformed subject</a>',
  );
  expect(html).toContain('href="/zh-Hant/subjects/subject-1/book?view=details#overview"');
  expect(html).toContain('Surrounding page');
});
