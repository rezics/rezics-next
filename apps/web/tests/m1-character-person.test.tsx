import { expect, mock, test } from 'bun:test';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import { characterRelationshipsFixture } from '../src/kernel/fake/character-relationships';
import { qualifiedRelationsPage } from '../src/kernel/fake/qualified-relations';
import { personReaderExample } from '../src/features/catalogue/person-reader/examples';
import type { SubjectPageData } from '../src/features/pages/subject';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage, subjectBody } = await import('../src/features/pages/subject');
const { subjectPageMessages } = await import('../src/features/pages/route-support');
const { CharacterRelationshipsView } = await import('../src/features/catalogue/character-relationships/view');
const { subjectVisitReturn } = await import('../src/features/pages/subject-visit-navigation');
const { m } = await import('../src/paraglide/messages.js');

function profile(
  read: SubjectRead,
  release: ReturnType<typeof personReaderExample>['release'],
  documents?: unknown,
): SubjectPageData {
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'SubjectHeader', props: { id: 'header' } }],
  };
  const plan = planReads(platformRegistry, document, { subject: read.subject.id });
  return {
    subject: read.subject.id,
    profile: 'illustrative',
    template: { scope: 'generic', key: null },
    document,
    catalogue: { state: 'released', type: read.subject.type, definitions: release },
    reads: Object.fromEntries(
      Object.keys(plan.reads).map((key) => [key, { status: 200, body: { ...read, documents } }]),
    ),
  };
}

// This is a page-composition test using existing native-format fixtures, not a seeded running-product pass.
test('Subject character facts lead to the production appearance reader, disclosed cast, distinct Person and exact work return in en, zh-Hant and ja', async () => {
  const person = personReaderExample();
  for (const locale of ['en', 'zh-Hant', 'ja'] as const) {
    const fixture = characterRelationshipsFixture('appearances', locale);
    fixture.character.subject.labels = { en: 'The traveler', ja: '旅人', 'zh-Hant': '旅人' };
    fixture.character.subject.aliases = { ja: ['旅の人'] };
    fixture.character.subject.statements['schema:height'] = [
      person.statement('schema:height', { amount: '+170', unit: '1' }, 'quantity'),
    ];
    const client = new QueryClient();
    const render = (node: ReactNode) => renderToStaticMarkup(h(QueryClientProvider, { client }, node));
    const draw = (page: SubjectPageData, returnTo?: string) =>
      render(
        h(SubjectPage, {
          page,
          locale,
          messages: subjectPageMessages(locale),
          renderJsonLd: false,
          ...(returnTo ? { returnTo } : {}),
        }),
      );
    const html = draw(profile(fixture.character, fixture.release));
    expect(html).toContain('data-slot="character-reader"');
    expect(html).toContain('旅の人');
    expect(html).toContain('170');
    expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('id="character-profile"'));
    expect(html).toContain(`/character-relationships`);
    expect(html).toContain(`/${locale}/subjects/${fixture.id}/`);
    expect(html).not.toContain('schema:height');
    const initial = await fixture.read();
    if (!initial.ok) throw new Error('Expected supplied appearance page');
    const appearances = render(
      h(CharacterRelationshipsView, {
        id: fixture.id,
        locale,
        transport: fixture.transport,
        search: fixture.search,
        initial,
        signedIn: false,
      }),
    );
    expect(appearances).toContain('data-slot="character-relationships"');
    const work = qualifiedRelationsPage();
    const originalWork = work.subject!;
    const appearance = initial.rows.find((row) => row.summary)?.summary;
    if (!appearance) throw new Error('Expected an admitted appearance destination');
    work.subject = appearance.id;
    subjectBody({ ...work, subject: originalWork })!.subject.id = appearance.id;
    work.reads = Object.fromEntries(
      Object.entries(work.reads).map(([key, value]) => [key.replaceAll(originalWork, appearance.id), value]),
    );
    const workRead = subjectBody(work)!;
    const workHtml = draw(work);
    expect(workHtml).toContain('Ada Player');
    expect(workHtml).toContain('A. Player');
    expect(workHtml).toContain('Voice');
    // Follow the actual admitted cast destination; the same label does not make it the character.
    const personId = /\/subjects\/([0-9a-f-]{36})\/[^"/]*ada[^"/]*/i.exec(workHtml)?.[1];
    expect(personId).toBeDefined();
    const personRead = structuredClone(person.read);
    personRead.subject.id = personId!;
    personRead.subject.labels = { en: 'Ada Player', ja: '旅人' };
    personRead.subject.aliases = { ja: ['別名'] };
    const back = `/${locale}/subjects/${work.subject}/work#connections`;
    expect(subjectVisitReturn(back, locale)).toBe(back);
    const documents = structuredClone(person.documents);
    for (const record of Object.values(documents))
      if (record && typeof record === 'object') Reflect.set(record, 'subjectId', personId);
    const personHtml = draw(profile(personRead, person.release, documents), back);
    expect(personHtml).toContain('data-slot="person-reader"');
    expect(personHtml).not.toContain('data-slot="character-reader"');
    expect(personHtml).toContain('Mira directs independent films.');
    expect(personHtml).toContain(back);
    expect(personHtml).toContain(m.showcase_people_credits({}, { locale }));
    expect(personHtml).toContain(`/${locale}/subjects/${personId}/`);
    expect(workRead.subject.id).not.toBe(personId);
    client.clear();
  }
});
