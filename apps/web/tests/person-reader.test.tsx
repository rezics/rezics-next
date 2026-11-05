import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { personReaderExample } from '../src/features/catalogue/person-reader/examples';
import { personGroups, personBounds, type PersonDefinitions } from '../src/features/catalogue/person-reader/model';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { PersonReader, PersonOverview } = await import('../src/features/catalogue/person-reader/reader');
const { m } = await import('../src/paraglide/messages.js');
const { locales } = await import('../src/paraglide/runtime.js');

test('ordinary Person overview places the reader; admitted authored text and labelled facts keep evidence and correction identity', async () => {
  const fixture = personReaderExample();
  fixture.read.subject.labels.ja = '本来の名前';
  fixture.read.subject.aliases.ja = ['別名'];
  const { SubjectPage } = await import('../src/features/pages/subject');
  const { subjectPageMessages } = await import('../src/features/pages/route-support');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'SubjectHeader', props: { id: 'header' } }],
  };
  const plan = planReads(platformRegistry, document, { subject: fixture.read.subject.id });
  const page = {
    subject: fixture.read.subject.id,
    profile: 'fixture',
    template: { scope: 'generic' as const, key: null },
    document,
    reads: Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: fixture.read }])),
  };
  const draw = (body: typeof page) =>
    renderToStaticMarkup(
      h(
        QueryClientProvider,
        { client },
        h(SubjectPage, { page: body, locale: 'en', messages: subjectPageMessages('en'), renderJsonLd: false }),
      ),
    );
  const overview = draw(page);
  expect(overview).toContain('data-slot="person-reader"');
  const organization = structuredClone(page);
  for (const read of Object.values(organization.reads)) read.body.subject.type = 'schema:Organization';
  expect(draw(organization)).not.toContain('data-slot="person-reader"');
  for (const locale of locales) {
    const html = renderToStaticMarkup(
      h(PersonReader, { public: fixture.read, release: fixture.release, documents: fixture.documents, locale }),
    );
    expect(html).toContain('Mira directs independent films.');
    expect(html).toContain('本来の名前');
    expect(html).toContain('別名');
    expect(html).toContain(m.people_occupations_title({}, { locale }));
    expect(html).toContain(m.people_languages_title({}, { locale }));
    expect(html).toContain(`/subjects/${fixture.occupation}/`);
    expect(html).toContain(`/subjects/${fixture.language}/`);
    expect(html).toContain('2020');
    expect(html).not.toMatch(/January|January 1|1月1日/);
    expect(html).toContain('https://example.org/biography');
    expect(html).toContain(fixture.biography);
    expect(html).toMatch(new RegExp(`/subjects/${fixture.read.subject.id}/[^"/]+/people`));
    expect(html).not.toContain('wdt:P106');
  }
});

test('unsupported, absent, unknown, withheld and unhydrated values remain distinct; native selection and rendering stay bounded', () => {
  const draw = (fixture: ReturnType<typeof personReaderExample>) =>
    renderToStaticMarkup(
      h(PersonReader, {
        public: fixture.read,
        release: fixture.release,
        documents: fixture.documents,
        locale: 'en',
      }),
    );
  const unavailable = m.candidate_value_unavailable({}, { locale: 'en' });
  const withheld = personReaderExample('withheld');
  expect(draw(withheld)).toContain(unavailable);
  expect(draw(withheld)).not.toContain(withheld.occupation);
  expect(draw(withheld)).not.toContain('Mira directs');
  expect(draw(withheld)).toContain(withheld.language);
  expect(draw(personReaderExample('empty'))).toContain(m.people_biography_absent({}, { locale: 'en' }));
  expect(draw(personReaderExample('unsupported'))).toContain(m.people_biography_unsupported({}, { locale: 'en' }));
  const fixture = personReaderExample();
  const occupation = fixture.read.subject.statements['wdt:P106']![0]!;
  occupation.value = { type: 'somevalue' };
  expect(draw(fixture)).toContain(m.subject_value_unknown({}, { locale: 'en' }));
  occupation.value = { type: 'novalue' };
  expect(draw(fixture)).toContain(m.subject_value_none({}, { locale: 'en' }));
  const hiddenPart = {
    property: { id: 'wdt:P106', data_type: 'wikibase-item' as const },
    value: { type: 'value' as const, content: 'hidden-target' },
  };
  occupation.qualifiers.push(hiddenPart);
  occupation.references[0]!.parts.push(hiddenPart);
  expect(draw(fixture)).not.toContain('hidden-target');
  fixture.read.subject.statements['wdt:P106'] = Array.from({ length: personBounds.facts + 1 }, () => ({
    ...occupation,
    id: crypto.randomUUID(),
  }));
  expect(personGroups(fixture.release, fixture.read, 'en')[1]!.fields[0]!.facts).toHaveLength(personBounds.facts);
  expect(draw(fixture)).toContain(m.people_facts_browse({}, { locale: 'en' }));
  expect(draw(fixture)).toContain(m.people_facts_overflow({}, { locale: 'en' }));
  const bio = fixture.read.subject.statements['schema:abstract']![0]!;
  fixture.read.subject.statements['schema:abstract']!.push({ ...bio, id: crypto.randomUUID(), rank: 'deprecated' });
  const record = fixture.documents[fixture.biography];
  if (typeof record !== 'object' || !record) throw new Error('Missing fixture document');
  Reflect.set(record, 'candidateId', 'old-candidate');
  expect(draw(fixture)).not.toContain('Mira directs independent films.');
});

test('old definition responses, expanded evidence and focused controls retire on source, locale, session, exposure and unmount', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(require.resolve('happy-dom', { paths: [require.resolve('@puckeditor/core')] }));
  const window = new Window({ url: 'https://site.test/en/subjects/person' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const fixture = personReaderExample();
  let source = {};
  let locale = 'en';
  let resolve: ((release: PersonDefinitions | null) => void) | undefined;
  const load = () =>
    new Promise<PersonDefinitions | null>((done) => {
      resolve = done;
    });
  const { CharacterOverview } = await import('../src/features/pages/showcase-people/character');
  let character = false;
  const draw = () =>
    act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(character ? CharacterOverview : PersonOverview, {
            source,
            viewer: null,
            public: fixture.read,
            documents: fixture.documents,
            locale,
            load,
          }),
        ),
      ),
    );
  try {
    await draw();
    const old = resolve!;
    source = {};
    await draw();
    await act(async () => old(fixture.release));
    expect(host.textContent).not.toContain('Mira directs');
    await act(async () => resolve!(fixture.release));
    expect(host.textContent).toContain('Mira directs');
    host.querySelector('details')!.open = true;
    const link = host.querySelector('a')!;
    link.focus();
    locale = 'ja';
    await draw();
    expect(host.textContent).not.toContain('Mira directs');
    expect(host.querySelector('details')).toBeNull();
    expect(window.document.activeElement?.id).toBe('person-biography');
    source = {};
    await draw();
    await act(async () => resolve!(fixture.release));
    expect(host.textContent).toContain('Mira directs');
    await act(async () => client.setQueryData(['exposure', 'viewer'], { spoilerLevel: 2 }));
    expect(host.textContent).not.toContain('Mira directs');
    source = {};
    await draw();
    await act(async () => resolve!(fixture.release));
    await act(async () =>
      client.setQueryData(['session'], { state: 'signed-in', subject: 'new-reader', csrfToken: 'new-session' }),
    );
    expect(host.textContent).not.toContain('Mira directs');
    source = {};
    character = true;
    fixture.read.subject.type = 'wd:Q95074';
    await draw();
    const priorCharacter = resolve!;
    source = {};
    await draw();
    await act(async () => priorCharacter(fixture.release));
    expect(host.querySelector('[data-slot="character-reader-facts"]')).toBeNull();
    await act(async () => resolve!(fixture.release));
    expect(host.querySelector('[data-slot="character-reader-facts"]')).not.toBeNull();
    await act(async () => client.setQueryData(['exposure', 'viewer'], { spoilerLevel: 0 }));
    expect(host.querySelector('[data-slot="character-reader-facts"]')).toBeNull();
    expect(host.querySelector('a[href*="character-relationships"]')).toBeNull();
    source = {};
    await draw();
    const last = resolve!;
    await act(async () => root.unmount());
    await act(async () => last(fixture.release));
    expect(host.textContent).toBe('');
  } finally {
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.happyDOM.abort();
  }
});
