import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('Semantic summary lists retain navigable headings, supplied authority and independent evidence', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const { createElement: h } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ContextDirectoryView } = await import('../src/features/contexts/view');
  const { directoryInput, detailHref, directoryHref } = await import('../src/features/contexts/model');
  const { WorkPartsPage } = await import('../src/features/catalogue/work-parts-page');
  const { workPartsFixture } = await import('../src/kernel/fake/work-parts');
  const { ConnectedStory } = await import('../src/stories/connected-story');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const document = window.document;
  try {
    const id = '00000000-0000-4000-8000-000000000901';
    const input = directoryInput({ query: '旅', deleted: true });
    const next = 'opaque+/page==';
    document.body.innerHTML = renderToStaticMarkup(
      h(ContextDirectoryView, {
        locale: 'en',
        input,
        reload: async () => {},
        data: {
          creation: { kind: 'denied' },
          page: {
            kind: 'ready',
            value: {
              next,
              contexts: [
                {
                  id,
                  kind: 'community',
                  labels: { ja: '旅の読者' },
                  state: 'deleted',
                  deletedAt: '2026-10-31T00:00:00Z',
                  purgeAfter: null,
                },
              ],
            },
          },
        },
      }),
    );
    const context = document.querySelector('ul > li')!;
    expect(context).not.toBeNull();
    const heading = context.querySelector('h2, h3, h4');
    expect(heading?.textContent).toBe('旅の読者');
    expect(heading?.getAttribute('lang')).toBe('ja');
    expect(context.querySelector('a')?.getAttribute('href')).toBe(detailHref('en', id));
    expect(context.textContent).toContain(m.ctxw_deleted());
    expect(
      [...document.querySelectorAll('a')].some(
        (a) => a.getAttribute('href') === directoryHref('en', { ...input, cursor: next }),
      ),
    ).toBe(true);
    expect(context.querySelector('a a')).toBeNull();

    const parts = workPartsFixture('partial');
    const read = await parts.transport.read();
    if (!read.ok || !read.rows[0]?.summary) throw new Error('Expected a resolved native summary');
    const calls = parts.calls.length;
    const renderParts = (initial: typeof read) => {
      document.body.innerHTML = renderToStaticMarkup(
        h(ConnectedStory, {
          storyId: 'semantic-summary-items',
          children: h(WorkPartsPage, {
            id: parts.id,
            locale: 'en',
            transport: parts.transport,
            search: parts.search,
            initial,
          }),
        }),
      );
      return document.querySelector('ul > li')!;
    };
    const row = renderParts(read);
    expect(row.querySelector('h2, h3, h4')?.textContent).toBe('Volume Two');
    const summary = read.rows[0].summary;
    const href = subjectHref({ id: summary.id, label: summary.label?.value ?? '' }, 'en').href;
    expect(row.querySelector('a')?.getAttribute('href')).toBe(href);
    expect(row.querySelector('a[href="https://example.org/contents"]')).not.toBeNull();
    expect([...row.querySelectorAll('button')].some((button) => button.textContent === m.work_parts_correct())).toBe(
      true,
    );
    const technical = row.querySelector('details');
    expect(technical?.hasAttribute('open')).toBe(false);
    expect(JSON.parse(technical!.querySelector('pre')!.textContent!)).toEqual(read.rows[0].statement);
    expect(row.querySelector('a a, a button, a details')).toBeNull();
    const unresolved = renderParts({ ...read, rows: [{ ...read.rows[0], summary: null }] });
    expect(unresolved.textContent).toContain(m.work_parts_unresolved());
    expect([...unresolved.querySelectorAll('a')].some((a) => a.getAttribute('href') === href)).toBe(false);
    expect(parts.calls).toHaveLength(calls);
  } finally {
    await window.happyDOM.abort();
  }
});
