import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { ConceptCreateFact } from '../src/features/catalogue/concept-create';

mock.module('cloudflare:workers', () => ({ env: {} }));

async function mounted(run: (page: { host: HTMLElement }) => Promise<void>) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/concept' });
  const names =
    'window document navigator HTMLElement HTMLButtonElement HTMLFormElement HTMLInputElement HTMLSelectElement Element Node DocumentFragment Document ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame matchMedia IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[name as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await run({
      host,
      async render(node: ReactNode) {
        await act(async () => root.render(node));
      },
    } as { host: HTMLElement } & { render: (node: ReactNode) => Promise<void> });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test('Concept fields distinguish scheme from concept and review multilingual terms with admitted evidence', async () => {
  await mounted(async (page) => {
    const { render, host } = page as typeof page & { render: (node: ReactNode) => Promise<void> };
    const { ConceptCreateFields } = await import('../src/features/catalogue/concept-create-fields');
    const { ConceptCreateReview } = await import('../src/features/catalogue/concept-create-review');
    const { ConceptCreateEntry } = await import('../src/features/catalogue/concept-create-entry');
    const { conceptCreateDraft, conceptCreateHolders } = await import('../src/features/catalogue/concept-create');
    const { CatalogueCurrentReading, catalogueEditor } = await import('../src/features/catalogue/editor-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const Fields = catalogueEditor(ConceptCreateFields);
    const facts: ConceptCreateFact[] = [
      {
        key: '00000000-0000-4000-8000-00000000f001',
        statement: {
          property: { id: 'skos:inScheme' },
          value: { type: 'value', content: '00000000-0000-4000-8000-00000000c102' },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
      },
    ];
    let current = facts;
    await render(
      h('div', null, [
        h(ConceptCreateEntry, { locale: 'en' }),
        h(
          CatalogueCurrentReading,
          { visible: true, ready: true, revision: 'concept' },
          h(Fields, {
            type: 'skos:Concept',
            release: bundledRelease,
            locale: 'en',
            search: async () => [
              {
                id: '00000000-0000-4000-8000-00000000c102',
                title: 'Existing scheme',
                types: ['skos:ConceptScheme'],
                typeLabel: 'Concept Scheme',
                cover: null,
              },
            ],
            facts: current,
            disabled: false,
            canEdit: () => true,
            change: (next: ConceptCreateFact[]) => {
              current = next;
            },
            invalidate: () => undefined,
            discardTypeDraft: () => undefined,
          }),
        ),
      ]),
    );
    expect(host.textContent).toContain(m.concept_create_facts());
    expect(host.textContent).toContain(m.concept_create_optional());
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/en/catalogue/concept');
    const prepared = conceptCreateDraft(
      bundledRelease,
      { type: 'skos:Concept', labels: { en: 'Night', ja: '夜'.repeat(40) }, descriptions: { ja: '時間' } },
      current,
    );
    await render(
      h(ConceptCreateReview, {
        item: prepared.item,
        holders: conceptCreateHolders(current),
        release: bundledRelease,
        locale: 'en',
        stale: false,
        factsId: 'concept-initial-facts',
        onJump: () => undefined,
      }),
    );
    expect(host.querySelector('[data-concept-create-review]')).toBeTruthy();
    expect(host.textContent).toContain(m.concept_create_grain_concept());
    expect(host.textContent).toContain('夜'.repeat(40));
    expect(host.textContent).toContain('skos:inScheme');
    expect(host.textContent).not.toContain('skos:closeMatch');
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: 'scheme' },
        h(Fields, {
          type: 'skos:ConceptScheme',
          release: bundledRelease,
          locale: 'en',
          search: async () => [],
          facts: [],
          disabled: false,
          canEdit: () => true,
          change: () => undefined,
          invalidate: () => undefined,
          discardTypeDraft: () => undefined,
        }),
      ),
    );
    expect(host.textContent).toContain(m.concept_create_scheme_optional());
  });
});
