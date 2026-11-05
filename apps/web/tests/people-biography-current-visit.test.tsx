import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import type { SubjectRead } from '@rezics/client';
import { peoplePersonId, peopleProfileFixture } from '../src/kernel/fake/catalogue-people-profile';
import { personBiographyReturn, personBiographyReturnFragment, subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { peopleBiographyAddress } from '../src/features/catalogue/people-biography/current-visit';

mock.module('cloudflare:workers', () => ({ env: {} }));

function statement(id: string, target: string) {
  return {
    id,
    rank: 'normal' as const,
    property: { id: 'wdt:P106', data_type: 'wikibase-item' as const },
    value: { type: 'value' as const, content: target },
    qualifiers: [],
    references: [],
    rezics: { release: 'sha256:fixture', revision: 1 },
  } satisfies SubjectRead['subject']['statements'][string][number];
}

test('the mounted Person visit returns to the exact current assertion and keeps unavailable targets unlabeled', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const fixture = peopleProfileFixture('ready', 'zh-Hant', 'person');
  const context = fixture.person.subject.context;
  const assertion = '00000000-0000-4000-8000-00000000d221';
  const targetId = '00000000-0000-4000-8000-00000000d201';
  fixture.person.subject.labels = { ja: '佐藤ミラ', en: 'Mira Sato', 'zh-Hant': '佐藤米拉' };
  fixture.person.subject.statements['wdt:P106'] = [statement(assertion, targetId)];
  fixture.person.related = {
    [targetId]: { type: 'skos:Concept', labels: { ja: '監督', en: 'Director', 'zh-Hant': '導演' } },
  };
  const locator = personBiographyReturnFragment({
    context,
    field: 'wdt:P106',
    assertion,
    window: 'occupations',
  });
  const returnAddress = peopleBiographyAddress(
    peoplePersonId,
    '佐藤米拉',
    'zh-Hant',
    context,
    'occupations',
    'wdt:P106',
    assertion,
  );
  expect(subjectVisitReturn(returnAddress, 'zh-Hant')).toBe(returnAddress);
  const window = new Window({
    url: `https://site.invalid/zh-Hant/subjects/${peoplePersonId}/mira/people?context=${context}${locator}`,
  });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'Document',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
  const { PeopleBiographyGroups: Visit } = await import('../src/features/catalogue/people-biography/groups');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('zh-Hant', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const render = (publicRead: SubjectRead, revision: string) =>
    h(
      CandidateReaderBoundary,
      {
        observed: { state: 'signed-in', subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', csrfToken: 'token' },
        address: 'people-current-visit',
      },
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision },
        h(Visit, {
          read: { ok: true, public: publicRead, release: fixture.release, source: null },
          locale: 'zh-Hant',
          search: async () => [],
          transport: {
            propose: fixture.propose,
            read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
          },
          review: fixture.review,
        }) as ReactNode,
      ) as ReactNode,
    );
  try {
    await act(async () => root.render(render(fixture.person, '1')));
    const target = [...host.querySelectorAll('a')].find((link) => link.textContent === '導演');
    expect(target?.getAttribute('lang')).toBe('zh-Hant');
    const targetAddress = new URL(target!.href);
    expect(targetAddress.searchParams.get('context')).toBe(context);
    const via = targetAddress.searchParams.get('via')!;
    expect(subjectVisitReturn(via, 'zh-Hant')).toBe(via);
    expect(new URL(via, 'https://site.invalid').hash).toContain(encodeURIComponent(assertion));
    expect(personBiographyReturn(new URL(via, 'https://site.invalid').hash)).toMatchObject({
      context,
      field: 'wdt:P106',
      assertion,
      window: 'occupations',
    });
    const inspection = [...host.querySelectorAll('a')].find((link) => link.href.includes('/value?'));
    expect(new URL(inspection!.href).searchParams.get('context')).toBe(context);
    const inspectionVia = new URL(inspection!.href).searchParams.get('via')!;
    expect(subjectVisitReturn(inspectionVia, 'zh-Hant')).toBe(inspectionVia);
    expect(new URL(inspectionVia, 'https://site.invalid').hash).toContain(encodeURIComponent(assertion));
    expect(window.document.activeElement?.id).toBe(`people-assertion-${assertion}`);
    expect(host.querySelector(`#people-assertion-${assertion} details`)?.hasAttribute('open')).toBe(true);

    const concealed = structuredClone(fixture.person);
    delete concealed.related[targetId];
    await act(async () => root.render(render(concealed, '2')));
    expect(host.textContent).toContain(m.people_biography_unreadable());
    expect(host.textContent).not.toContain(targetId);
    expect([...host.querySelectorAll('a')].some((link) => link.href.includes(targetId))).toBe(false);
    expect(window.document.activeElement?.id).toBe(`people-assertion-${assertion}`);

    const replaced = structuredClone(fixture.person);
    replaced.subject.statements['wdt:P106'] = [statement('00000000-0000-4000-8000-00000000d222', targetId)];
    await act(async () => root.render(render(replaced, '3')));
    expect(host.textContent).toContain(m.people_facts_changed());
    expect(window.document.activeElement?.id).toBe('people-field-wdt%3AP106');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
