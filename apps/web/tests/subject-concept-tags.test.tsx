import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Release } from '@rezics/definitions';
import type { Related, Subject } from '../src/subject/types';
import type { Stmt } from '../src/features/pages/shared';
import { subjectHref } from '../src/subject/subject-href';
import { SubjectConceptTags } from '../src/features/pages/subject-slots';

const property = 'schema:genre';
const definitions = () =>
  ({
    types: {
      'schema:CreativeWork': { bases: [], facets: [] },
      'schema:Book': { bases: ['schema:CreativeWork'], facets: [property] },
      'skos:Concept': { bases: [], facets: [] },
    },
    properties: { [property]: { datatype: 'wikibase-item', labels: { en: 'Themes' } } },
  }) as unknown as Pick<Release, 'types' | 'properties'>;

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const snak = (propertyId: string, dataType: string, content: unknown) => ({
  property: { id: propertyId, data_type: dataType },
  value: { type: 'value', content },
});

function statement(index: number, targetId: string, weight?: string, spoiler = 0): Stmt {
  const qualifiers = [
    ...(weight === undefined
      ? []
      : [
          snak('rezics:sourceTagWeight', 'quantity', { amount: weight, unit: '1' }),
          snak('rezics:sourceTagWeightMetric', 'string', 'vndbTagsRating'),
        ]),
    ...(spoiler ? [snak('rezics:spoilerLevel', 'quantity', { amount: `+${spoiler}`, unit: '1' })] : []),
  ];
  const references =
    weight === undefined
      ? []
      : [
          {
            parts: [
              snak('schema:url', 'url', `https://vndb.org/v${index + 1}`),
              snak('rezics:sourceTagId', 'string', `g${index + 1}`),
              snak('rezics:sourceSnapshot', 'string', `unversioned:sha256:${'a'.repeat(64)}`),
            ],
          },
          { parts: [snak('schema:url', 'url', 'https://api.vndb.org/kana#post-vn')] },
        ];
  return {
    id: uuid(index + 1000),
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: targetId },
    qualifiers,
    references,
    rezics: { release: `release-${index < 30 ? 'a' : 'b'}`, revision: 1 },
  } as unknown as Stmt;
}

function work(id: string, release: string, statements: Stmt[]): Subject {
  return {
    id,
    type: 'schema:Book',
    context: 'global',
    release,
    revision: release === 'release-a' ? 3 : 4,
    labels: { en: release === 'release-a' ? 'Work A' : 'Work B' },
    statements: { [property]: statements },
  } as unknown as Subject;
}

function tags(entries: readonly { id: string; label?: string; lang?: string; redirect?: string }[]): Related {
  return Object.fromEntries(
    entries.flatMap(({ id, label, lang, redirect }) =>
      label === undefined
        ? []
        : [[id, { type: 'skos:Concept', labels: { [lang ?? 'en']: label }, ...(redirect ? { redirect } : {}) }]],
    ),
  ) as unknown as Related;
}

test('mounted work tags paginate, retain source assertions, gate each spoiler, and reset on caller and release replacement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/work-a' });
  const globals =
    'window document navigator HTMLElement HTMLButtonElement Element Node DocumentFragment ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame matchMedia IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const previous = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of globals) {
    const value = name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[name as keyof typeof window];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    const conceptIds = Array.from({ length: 30 }, (_, index) => uuid(index + 100));
    conceptIds[1] = conceptIds[0]!;
    const statements = conceptIds.map((id, index) =>
      statement(index, id, index === 0 || index === 14 ? (index === 0 ? '+2.6' : '+2.1') : undefined, index === 14 || index === 18 ? 2 : 0),
    );
    const longLabel = '連続した日本語タグ名称'.repeat(12);
    const relatedEntries = [...new Set(conceptIds.slice(0, 29))].map((id, index) => ({
      id,
      label:
        id === conceptIds[0]
          ? 'Shared concept'
          : id === conceptIds[14]
            ? 'Secret plot tag fourteen'
            : id === conceptIds[18]
              ? 'Secret plot tag eighteen'
              : id === conceptIds[22]
                ? longLabel
              : `Theme ${index}`,
      ...(id === conceptIds[22] ? { lang: 'ja' } : {}),
      ...(id === conceptIds[0] ? { redirect: uuid(999) } : {}),
    }));
    const firstSubject = work(uuid(1), 'release-a', statements);
    const firstRelated = tags(relatedEntries);
    const firstDefinitions = definitions();
    const props = {
      subject: firstSubject,
      related: firstRelated,
      definitions: firstDefinitions,
      locale: 'en',
      spoilerThreshold: 0,
    };

    await act(async () => root.render(<SubjectConceptTags {...props} />));
    expect(host.textContent).toContain('27 tags');
    expect(host.textContent).toContain('Themes');
    expect(host.textContent).toContain('Shared concept');
    expect(host.innerHTML).toContain('data-state="available"');
    expect(host.innerHTML).toContain('data-state="absent"');
    expect(host.innerHTML).toContain('https://api.vndb.org/kana#post-vn');
    expect(host.innerHTML).toContain('https://vndb.org/v1');
    expect(host.innerHTML).not.toContain(conceptIds[14]!);
    expect(host.innerHTML).not.toContain('Secret plot tag fourteen');

    const firstWhy = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent?.trim() === 'Why this tag applies',
    )!;
    const firstEvidence = new URL(firstWhy.href);
    expect(firstEvidence.searchParams.get('role')).toBe(property);
    expect(firstEvidence.searchParams.get('returnTo')).toBe(
      subjectHref({ id: firstSubject.id, label: 'Work A' }, 'en').href,
    );
    const firstConcept = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent?.trim() === 'Shared concept',
    )!;
    expect(new URL(firstConcept.href).pathname).toContain(conceptIds[0]!);
    expect(new URL(firstConcept.href).pathname).not.toContain(uuid(999));

    const more = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'More tags');
    await act(async () => more()!.click());
    expect(host.textContent).toContain(longLabel);
    expect(host.innerHTML).toContain('lang="ja"');
    expect([...host.querySelectorAll('a')].some((link) => link.textContent?.trim() === 'Why this tag applies')).toBe(true);
    expect(host.innerHTML).not.toContain('Secret plot tag fourteen');
    expect(host.innerHTML).not.toContain('https://vndb.org/v15');
    expect(host.innerHTML).not.toContain(conceptIds[14]!);
    const reveal = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Reveal spoiler tag',
    )!;
    await act(async () => reveal.click());
    expect(host.textContent).toContain('Secret plot tag fourteen');
    expect(host.textContent).not.toContain('Secret plot tag eighteen');
    expect(host.innerHTML).toContain('https://vndb.org/v15');
    const spoilerWhy = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent?.trim() === 'Why this tag applies' && link.href.includes(conceptIds[14]!),
    );
    expect(spoilerWhy).toBeDefined();
    expect(new URL(spoilerWhy!.href).searchParams.get('tagQualifiers')).toBe(
      JSON.stringify([{ property: 'rezics:spoilerLevel', in: [2] }]),
    );

    await act(async () => more()!.click());
    expect(host.textContent).toContain('Tag label unavailable.');
    expect(host.innerHTML).not.toContain(conceptIds[29]!);
    expect(host.textContent).toContain('27 tags');

    const nextId = uuid(200);
    const nextSubject = work(uuid(2), 'release-b', [statement(31, nextId)]);
    const nextProps = {
      subject: nextSubject,
      related: tags([{ id: nextId, label: 'Replacement release tag' }]),
      definitions: definitions(),
      locale: 'en',
      spoilerThreshold: 0,
    };
    await act(async () => root.render(<SubjectConceptTags {...nextProps} />));
    expect(host.textContent).toContain('Replacement release tag');
    expect(host.textContent).not.toContain('Theme 2');
    expect(host.textContent).not.toContain('Secret plot tag');
    expect(more()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const name of globals) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.abort();
  }
});
