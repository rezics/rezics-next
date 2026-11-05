import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { LinkProps } from '../src/features/pages/shared';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

// UNRUN under MINIMAL: mounted presentation coverage; native, browser and visual acceptance remains deferred.
test('Subject source record summaries use the shared item family with complete attribution', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/subjects/subject/lectures' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { PageData, SubjectSources, dataComponents } = await import('../src/features/pages/data');
  const { CompositionRender } = await import('../src/features/pages/render');
  const { pageDefinitions, layoutComponents, PageRoot } = await import('../src/features/pages/layout');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const previousLocale = getLocale();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    throw new Error('Supplied source evidence must render without requests');
  }) as typeof fetch;

  const subject = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const longName = `Zulu — ${'資料と権利 المعلوماتSansEspaces'.repeat(18)}`;
  const sourceUrl = `https://source.example.test/${'very-long-source-path'.repeat(18)}?edition=original#credit`;
  const licenceUrl = 'https://rights.example.test/licence?version=1#terms';
  const viaUrl = 'https://cover.example.test/original?image=1#credit';
  const bareUrl = `https://evidence.example.test/${'unbroken-path'.repeat(24)}?record=7#citation`;
  const plainUrl = 'urn:catalogue:unlinked-evidence';
  const plainLicence = 'Permission recorded in the original catalogue — 全文保留';
  const attribution = '© Équipe des archives — جميع الحقوق محفوظة — attribution intégrale';
  const records = [
    { name: longName, url: sourceUrl, licence: { id: 'CC BY-SA 4.0 / 全文', url: licenceUrl }, attribution },
    { name: 'Alpha — archive secondaire', url: 'https://second.example.test/', licence: { id: plainLicence } },
    // Repeated destinations and repeated records remain separate supplied occurrences.
    { name: longName, url: sourceUrl, licence: { id: 'CC BY-SA 4.0 / 全文', url: licenceUrl }, attribution },
    { name: 'بدون بيانات إضافية', url: 'https://third.example.test/' },
  ];
  const credit = {
    rightsHolder: 'Artiste de couverture / 表紙の著作者',
    via: { name: 'Archives des couvertures', url: viaUrl },
    license: 'Cover permission only — 原画の利用条件',
  };
  const snak = (property: string, dataType: string, content: string) => ({
    property: { id: property, data_type: dataType },
    value: { type: 'value', content },
  });
  const identifier = (property: string, content: string, urls: string[] = []) => ({
    id: `statement-${property}`,
    rank: 'normal',
    ...snak(property, 'external-id', content),
    qualifiers: [],
    references: urls.map((url) => ({ parts: [snak('schema:url', 'url', url)] })),
  });
  const body = {
    subject: {
      id: subject,
      type: 'schema:Book',
      revision: 1,
      release: 'sha256:0',
      context: '00000000-0000-8000-8000-000000000000',
      resolution: {},
      labels: { fr: 'Lectures', ja: '資料' },
      descriptions: {},
      aliases: {},
      sourceRecords: records as unknown[],
      statements: {
        'example:catalogue': [identifier('example:catalogue', 'CAT-42', [sourceUrl, bareUrl, plainUrl])],
        'example:arabic': [identifier('example:arabic', 'AR-42')],
        'example:unlabelled': [identifier('example:unlabelled', 'UNLABELLED-42')],
      },
    },
    related: {
      'example:catalogue': { labels: { fr: 'identifiant du catalogue', ja: '目録番号' } },
      'example:arabic': { labels: { ar: 'معرّف الأرشيف' } },
    },
    summary: { id: subject, type: 'schema:Book', cover: { media: 'cover-file', credit } },
  };
  const before = structuredClone(body);
  const navigations: string[] = [];
  function OriginalPageLink({ href, children, ...props }: LinkProps) {
    return (
      <a
        {...props}
        data-original-page-link=""
        href={href}
        onClick={(event) => {
          event.preventDefault();
          navigations.push(href);
        }}
      >
        {children}
      </a>
    );
  }
  const host = window.document.createElement('main') as unknown as HTMLElement;
  host.dir = 'rtl';
  host.style.width = '320px';
  window.document.body.append(host);
  const root = createRoot(host);
  const show = async (mode: 'composed' | 'default', locale: 'fr' | 'ja', supplied = body) => {
    const document = {
      root: { props: {} },
      content:
        mode === 'composed'
          ? [{ type: 'Sources', props: { id: 'source-evidence' } }]
          : [{ type: 'Statements', props: { id: 'facts', properties: [] } }],
    } satisfies CompositionDocument;
    const plan = planReads(platformRegistry, document, { subject });
    const reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: supplied }]));
    const options = { locale };
    await act(async () => {
      root.render(
        <PageData
          locale={locale}
          subject={subject}
          subjectLabel="Lectures"
          document={document as never}
          reads={reads}
          link={OriginalPageLink}
          messages={{
            unknown: m.subject_value_unknown({}, options),
            none: m.subject_value_none({}, options),
            unlabelled: m.subject_value_unlabelled({}, options),
            sources: m.subject_sources({}, options),
            aliases: '',
            search: '',
            source: m.subject_source({}, options),
            licence: m.subject_source_licence({}, options),
            cover: m.subject_cover_credit({}, options),
            coverVia: m.subject_cover_via({}, options),
            details: m.subject_details({}, options),
          }}
        >
          {mode === 'composed' ? (
            <CompositionRender
              document={document as never}
              definitions={pageDefinitions}
              components={{ ...layoutComponents, ...dataComponents }}
              root={PageRoot}
            />
          ) : (
            <SubjectSources />
          )}
        </PageData>,
      );
    });
  };

  try {
    setLocale('en', { reload: false });
    for (const mode of ['composed', 'default'] as const) {
      for (const locale of ['fr', 'ja'] as const) {
        await show(mode, locale);
        const options = { locale };
        const section = host.querySelector('section[data-slot="subject-sources"]')!;
        expect(host.querySelectorAll('[data-slot="subject-sources"]')).toHaveLength(1);
        expect(section.id).toBe(mode === 'composed' ? 'source-evidence' : 'subject-sources');
        expect(section.getAttribute('aria-labelledby')).toBe(`${section.id}-title`);
        expect(section.querySelector('h2')?.textContent).toBe(m.subject_sources({}, options));
        expect(section.querySelector('h2')?.id).toBe(`${section.id}-title`);
        const rows = [...section.querySelectorAll(':scope > ul > li')];
        expect(rows).toHaveLength(10); // Credit, four records, two bare values, three identifiers.
        const named = rows.filter((row) => row.querySelector('h3'));
        expect(named.map((row) => row.querySelector('h3')?.textContent)).toEqual(records.map(({ name }) => name));
        expect([...section.querySelectorAll('h2, h3')].map((node) => node.tagName)).toEqual([
          'H2',
          'H3',
          'H3',
          'H3',
          'H3',
        ]);
        expect(
          section.querySelector('li li, a a, a button, img, details, [hidden], [aria-hidden="true"] h3'),
        ).toBeNull();
        for (const [index, row] of named.entries()) {
          const heading = row.querySelector('h3')!;
          const primary = heading.querySelector<HTMLAnchorElement>('a')!;
          expect(heading.getAttribute('data-content-item-slot')).toBe('title');
          expect(primary.textContent).toBe(records[index]!.name);
          expect(primary.getAttribute('href')).toBe(records[index]!.url);
          expect(primary.hasAttribute('target') || primary.hasAttribute('data-original-page-link')).toBe(false);
          expect(primary.className).not.toContain('after:inset-0');
          expect(heading.className).toContain('[overflow-wrap:anywhere]');
          expect(row.className).toContain('[overflow-wrap:anywhere]');
          expect(row.innerHTML).not.toMatch(/line-clamp|truncate|overflow-hidden|text-left|text-right|dir="ltr"/);
          expect(row.querySelector('[data-content-item-slot="context"]')?.textContent).toBe(
            m.subject_source({}, options),
          );
          expect(heading.parentElement?.className).toContain('has-[:focus-visible]:before:opacity-100');
          for (const link of row.querySelectorAll<HTMLAnchorElement>('a')) {
            expect(link.classList.contains('min-h-11')).toBe(true);
            expect(link.classList.contains('focus-visible:outline-2')).toBe(true);
            expect(link.hasAttribute('tabindex') || link.hasAttribute('role') || link.hasAttribute('target')).toBe(
              false,
            );
          }
        }
        const metadata = named[0]!.querySelector('[data-content-item-slot="metadata"]')!;
        expect(metadata.getAttribute('data-slot')).toBe('list-row-control');
        expect(metadata.classList.contains('z-10')).toBe(true);
        expect([...metadata.querySelectorAll('p')].map((node) => node.textContent)).toEqual([
          `${m.subject_source_licence({}, options)}: ${records[0]!.licence!.id}`,
          attribution,
        ]);
        expect(metadata.querySelector('a')?.getAttribute('href')).toBe(licenceUrl);
        expect(named[1]!.querySelectorAll('a')).toHaveLength(1);
        expect(named[1]!.querySelector('[data-content-item-slot="metadata"]')?.textContent).toBe(
          `${m.subject_source_licence({}, options)}: ${plainLicence}`,
        );
        expect(named[3]!.querySelector('[data-content-item-slot="metadata"]')).toBeNull();
        expect(rows[0]!.textContent).toContain(`© ${credit.rightsHolder}`);
        expect(rows[0]!.textContent).toContain(credit.license);
        expect(rows[0]!.textContent).toContain(m.subject_cover_via({}, options));
        expect(rows[0]!.querySelector('a')?.textContent).toBe(credit.via.name);
        expect(rows[5]!.querySelector('a')?.textContent).toBe(bareUrl);
        expect(rows[5]!.querySelector('a')?.classList.contains('break-all')).toBe(true);
        expect(rows[6]!.textContent).toContain(plainUrl);
        expect(rows[6]!.querySelector('a, h3')).toBeNull();
        expect(rows[7]!.textContent).toBe(`${locale === 'fr' ? 'Identifiant du catalogue' : '目録番号'}CAT-42`);
        expect(rows[8]!.querySelector('[lang="ar"]')?.textContent).toBe('معرّف الأرشيف');
        expect(rows[8]!.textContent).toContain('AR-42');
        expect(rows[9]!.textContent).toBe(`${m.subject_value_unlabelled({}, options)}UNLABELLED-42`);
        expect(rows.slice(5).some((row) => row.querySelector('[data-content-item-slot="title"]'))).toBe(false);
        const links = [...section.querySelectorAll<HTMLAnchorElement>('a')];
        const detailsHref = `/${locale}/subjects/${subject}/lectures/details`;
        expect(links.map((link) => link.getAttribute('href'))).toEqual([
          viaUrl,
          sourceUrl,
          licenceUrl,
          records[1]!.url,
          sourceUrl,
          licenceUrl,
          records[3]!.url,
          bareUrl,
          detailsHref,
        ]);
        expect(links.at(-1)?.textContent).toBe(m.subject_details({}, options));
        expect(links.at(-1)?.hasAttribute('data-original-page-link')).toBe(true);
        const destinations: string[] = [];
        for (const link of links.slice(0, -1))
          link.addEventListener('click', (event) => {
            event.preventDefault();
            destinations.push(link.getAttribute('href')!);
          });
        host.ownerDocument.activeElement instanceof HTMLElement &&
          (host.ownerDocument.activeElement as HTMLElement).blur();
        for (const link of links) {
          await user.tab();
          expect(window.document.activeElement).toBe(link);
          await user.keyboard('{Enter}');
        }
        expect(destinations).toEqual(links.slice(0, -1).map((link) => link.getAttribute('href')!));
        expect(navigations.at(-1)).toBe(detailsHref);
        expect(body).toEqual(before);
      }
    }
    // Returned rows are rendered once each, without per-row reads, sorting or deduplication.
    for (const size of [1, 8, 32]) {
      const supplied = structuredClone(body);
      supplied.subject.sourceRecords = Array.from({ length: size }, (_, index) => records[index % records.length]!);
      await show('composed', 'fr', supplied);
      expect([...host.querySelectorAll('h3')].map((node) => node.textContent)).toEqual(
        supplied.subject.sourceRecords.map((record) => (record as { name: string }).name),
      );
      expect(host.querySelectorAll('h3 a')).toHaveLength(size);
    }
    const empty = structuredClone(body);
    empty.subject.sourceRecords = [{ name: 'Missing destination' }, { url: 'https://unnamed.example.test/' }, null];
    empty.subject.statements = {} as typeof empty.subject.statements;
    empty.summary = null as never;
    for (const mode of ['composed', 'default'] as const) {
      await show(mode, 'fr', empty);
      expect(host.querySelector('section, ul, h2, h3, a')).toBeNull();
    }
    expect(requests).toEqual([]);
    expect(body).toEqual(before);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
