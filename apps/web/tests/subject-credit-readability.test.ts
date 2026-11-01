import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { longCredit, longCreditPage } from '../src/stories/qualified-relations-data';
import { qualifiedRealm } from '../src/kernel/fake/qualified-relations';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { relationDefinitions } from '../src/subject/relations';
import { m } from '../src/paraglide/messages.js';
import type { SubjectPageData } from '../src/features/pages/subject';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { SubjectPage, pageContext, pageRelationProperties } = await import('../src/features/pages/subject');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

function render(page: SubjectPageData, locale = 'en', properties = definitions.release.properties) {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client: new QueryClient(),
      children: createElement(SubjectPage, {
        page,
        locale,
        renderJsonLd: false,
        relations: relationDefinitions({ properties }, pageRelationProperties(page), locale),
        messages: { unknown: 'Unknown', none: 'None', unlabelled: 'Unlabelled', sources: 'Sources' },
      }),
    }),
  );
}

// This is DOM/content coverage; actual layout at phone390 and desktop1280 remains in the populated stories.
test('Subject credits preserve readable person role character and credited-as information and relation headings and continuations use recognizable labels', async () => {
  const window = new Window({ url: 'https://rezics.test' });
  try {
    const page = longCreditPage();
    const plan = planReads(platformRegistry, page.document, pageContext(page));
    const cast = page.reads[plan.nodes.cast!]!.body as { relations: Record<string, any>[] };
    const unqualified = structuredClone(cast.relations[0]!);
    unqualified.statement.id = 'unqualified-credit';
    unqualified.statement.qualifiers = [];
    unqualified.label = 'A performer whose complete name also needs enough room to wrap over several lines';
    cast.relations.push(unqualified);
    delete page.document.content.find((node) => node.props.id === 'cast')!.props.title;
    page.context = { id: qualifiedRealm, population: { kind: 'realm', id: qualifiedRealm, title: 'Cast community' } };
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
      const host = window.document.createElement('main');
      host.innerHTML = render(page, locale);
      const section = host.querySelector('[data-node="cast"]')!;
      const label = m.subject_cast({}, { locale: locale as never });
      expect(section.querySelector('h2')!.textContent).toBe(label);
      const cards = Array.from(section.querySelectorAll('article'));
      expect(cards).toHaveLength(2);
      const first = cards[0]!;
      for (const text of Object.values(longCredit)) expect(first.textContent).toContain(text);
      const fields = first.querySelector('[data-slot="cover-card-essential-credit"]')!;
      expect(fields.className).toContain('wrap-anywhere');
      expect(fields.className).not.toMatch(/line-clamp|truncate|overflow-hidden/);
      expect(first.querySelector('[lang="ja"]')!.textContent).toContain(longCredit.name);
      expect(first.querySelector('[data-property="wdt:P3831"]')!.textContent).toContain(longCredit.role);
      expect(first.querySelector('[data-property="wdt:P453"]')!.textContent).toContain(longCredit.character);
      expect(first.querySelector('[data-slot="cover-card-secondary"]')).toBeNull();
      expect(first.querySelector('a a')).toBeNull();
      expect(first.querySelectorAll('a')).toHaveLength(3);
      for (const link of first.querySelectorAll('a')) {
        const href = new URL(link.getAttribute('href')!, window.location.href);
        expect(href.pathname).toContain(`/${locale}/subjects/`);
        expect(href.searchParams.get('realm')).toBe(qualifiedRealm);
      }
      const title = cards[1]!.querySelector('a')!;
      expect(title.textContent).toBe(unqualified.label);
      expect(title.className).not.toMatch(/line-clamp|truncate/);
      expect(cards[1]!.querySelector('ul')).toBeNull();
      const more = section.querySelector('[data-slot="continue-group"]')!;
      expect(more.textContent).toBe(m.subject_section_more({ label }, { locale: locale as never }));
      expect(more.getAttribute('aria-describedby')).toBe('cast-title');
      const href = new URL(more.getAttribute('href')!, window.location.href);
      expect(href.searchParams.get('node')).toBe('cast');
      expect(href.searchParams.get('cursor')).toBe('cast-next');
      expect(href.searchParams.get('realm')).toBe(qualifiedRealm);
    }
  } finally {
    await window.happyDOM.close();
  }
});

function extensionPage(paged: boolean): SubjectPageData {
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'SubjectList', props: { id: 'extension', property: 'example:inspired', paged, limit: 12 } }],
  };
  const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e92';
  const plan = planReads(platformRegistry, document, { subject });
  return {
    subject,
    profile: 'extension',
    template: { scope: 'type', key: 'schema:Book' },
    document,
    reads: Object.fromEntries(
      Object.keys(plan.reads).map((key) => [
        key,
        {
          status: 200,
          body: {
            links: [
              {
                subject: 'related-subject',
                statement: 'related-statement',
                label: 'Related work',
                summary: { id: 'related-subject', type: 'schema:Book' },
              },
            ],
            next: 'extension-next',
          },
        },
      ]),
    ),
  };
}

test('unknown extension headings retain their meaningful released label in previews and continuations', async () => {
  const window = new Window({ url: 'https://rezics.test' });
  try {
    const properties = { 'example:inspired': { labels: { en: 'inspired works' } } };
    for (const paged of [false, true]) {
      const host = window.document.createElement('main');
      host.innerHTML = render(extensionPage(paged), 'en', properties as never);
      expect(host.querySelector('h2')!.textContent).toBe('Inspired works');
      const more = host.querySelector(paged ? '[data-slot="continue-group"]' : '[data-slot="see-all"]')!;
      expect(more.textContent).toContain('Inspired works');
      const href = new URL(more.getAttribute('href')!, window.location.href);
      if (paged) {
        expect(href.searchParams.get('node')).toBe('extension');
        expect(href.searchParams.get('cursor')).toBe('extension-next');
      } else expect(href.searchParams.get('property')).toBe('example:inspired');
    }
  } finally {
    await window.happyDOM.close();
  }
});

test('authored multilingual stream headings keep their language and continuation context', async () => {
  const window = new Window({ url: 'https://rezics.test' });
  try {
    const page = longCreditPage();
    page.document.content.find((node) => node.props.id === 'cast')!.props.title = { ja: '声の出演と語り' };
    const host = window.document.createElement('main');
    host.innerHTML = render(page);
    const section = host.querySelector('[data-node="cast"]')!;
    expect(section.querySelector('h2')!.getAttribute('lang')).toBe('ja');
    expect(section.querySelector('h2')!.textContent).toBe('声の出演と語り');
    expect(section.querySelector('[data-slot="continue-group"]')!.textContent).toBe('More: 声の出演と語り');
  } finally {
    await window.happyDOM.close();
  }
});
