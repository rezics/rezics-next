import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import type { FactCommand, FactsCurrent } from '../src/features/catalogue/subject-facts';
import type { CandidateTransport } from '../src/subject/candidate-review';

mock.module('cloudflare:workers', () => ({ env: {} }));

async function mounted(
  run: (page: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    enter: (input: HTMLInputElement, value: string) => Promise<void>;
    choose: (select: HTMLSelectElement, value: string) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const names =
    'window document navigator HTMLElement HTMLButtonElement HTMLFormElement HTMLInputElement HTMLSelectElement Element Node DocumentFragment Document ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame matchMedia IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[name as keyof typeof window],
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
      render: async (node) => act(async () => root.render(node)),
      enter: async (input, value) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
      },
      choose: async (select, value) => {
        await act(async () => {
          select.value = value;
          select.dispatchEvent(new window.Event('change', { bubbles: true }));
        });
      },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function button(region: ParentNode, name: string) {
  const found = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
  expect(found).toBeDefined();
  return found!;
}

function field(root: ParentNode, property: string) {
  const region = root.querySelector<HTMLElement>(`[data-classification-property="${property}"]`);
  expect(region).toBeDefined();
  return region!;
}

const keywords = 'schema:keywords';
const gender = 'schema:gender';
const concept = '00000000-0000-4000-8000-00000000d101';
const replacement = '00000000-0000-4000-8000-00000000d102';
const evidence = 'https://archive.example/character/original';

test('Character classifications review the changed set, copy evidence, repair a nested part, and return independent native outcomes', async () => {
  await mounted(async ({ host, render, enter, choose }) => {
    const { CharacterClassifications } = await import('../src/features/catalogue/character-profile-classification');
    const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
    const { statementInput } = await import('../src/features/catalogue/statement-editor');
    const { m } = await import('../src/paraglide/messages.js');
    const { characterProfileFixture, characterProfileId } =
      await import('../src/kernel/fake/catalogue-character-profile');
    const fixture = characterProfileFixture();
    const read: FactsCurrent = {
      ok: true,
      public: fixture.character,
      release: structuredClone(fixture.release),
      source: null,
    };
    const seed = read.public.subject.statements['schema:height']![0]!;
    read.public.subject.statements[keywords] = [
      {
        ...structuredClone(seed),
        id: '00000000-0000-4000-8000-000000008001',
        property: { id: keywords, data_type: 'wikibase-item' },
        value: { type: 'value', content: concept },
        qualifiers: [
          {
            property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
            value: { type: 'value', content: { amount: '+1', unit: '1' } },
          },
        ],
        references: [
          {
            hash: 'grouped',
            parts: [
              { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: evidence } },
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value', content: `${evidence}/note` },
              },
            ],
          },
        ],
      },
      {
        ...structuredClone(seed),
        id: '00000000-0000-4000-8000-000000008011',
        property: { id: keywords, data_type: 'wikibase-item' },
        value: { type: 'value', content: replacement },
        references: [],
      },
    ];
    read.public.subject.statements[gender] = [
      {
        ...structuredClone(seed),
        id: '00000000-0000-4000-8000-000000008002',
        property: { id: gender, data_type: 'wikibase-item' },
        value: { type: 'value', content: replacement },
        references: [],
      },
    ];
    read.public.related[concept] = { type: 'skos:Concept', labels: { ja: '出典で明示された分類' } };
    read.public.related[replacement] = { type: 'skos:Concept', labels: { en: 'Another supplied classification' } };
    const commands: FactCommand[] = [];
    const native = fixture.props.facts(characterProfileId);
    const transport = {
      ...native,
      propose: async (command: FactCommand) => {
        commands.push(command);
        if (command.statement.property.id === gender) return { ok: false as const, reason: 'denied' as const };
        return native.propose(command);
      },
      read: async () => {
        const next = structuredClone(read);
        next.public.subject.statements[keywords] = [
          {
            ...read.public.subject.statements[keywords]![0]!,
            value: { type: 'value', content: replacement },
          },
        ];
        return next;
      },
    };
    const reviews: { property: string; session?: string }[] = [];
    const review = (property: string, session?: string): CandidateTransport => {
      reviews.push({ property, session });
      return fixture.props.review(characterProfileId, property, session);
    };
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: 'current' },
        h(CharacterClassifications, {
          changedSetReview: true,
          properties: [keywords, gender],
          read,
          locale: 'en',
          search: async () => [
            {
              id: concept,
              title: '出典で明示された分類',
              types: ['skos:Concept'],
              typeLabel: 'Concept',
              cover: null,
            },
          ],
          transport,
          review,
        }),
      ),
    );
    const root = host;
    expect(root.textContent).toContain(concept);
    expect(root.textContent).toContain('出典で明示された分類');
    expect(root.textContent).toContain(replacement);
    expect(root.textContent).not.toContain('A search label');
    await choose(
      field(root, keywords).querySelector<HTMLSelectElement>('select')!,
      read.public.subject.statements[keywords]![0]!.id,
    );
    await act(async () => button(field(root, keywords), m.facts_edit_field()).click());
    await enter(field(root, keywords).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/edited`);
    await act(async () => button(field(root, gender), m.facts_edit_field()).click());
    await act(async () =>
      [...field(root, keywords).querySelectorAll('button')]
        .find((node) => node.textContent === m.facts_reuse_reference())!
        .click(),
    );
    const reusePanel = root.querySelector('[data-fact-reuse]')!;
    const check = reusePanel.querySelector<HTMLElement>('button[role="checkbox"], input[type="checkbox"]')!;
    await act(async () => check.click());
    await act(async () => button(root, m.facts_reuse_apply()).click());
    expect(field(root, gender).querySelectorAll('input[type="url"]').length).toBeGreaterThan(0);
    expect(root.textContent).toContain(m.classification_siblings_retained());
    await act(async () => button(root, m.facts_review_open_field()).click());
    expect(root.textContent).toContain(m.facts_review_stale());
    const nested = field(root, keywords).querySelector<HTMLInputElement>('input[type="url"]')!;
    await enter(nested, `${evidence}/repaired`);
    await act(async () => button(root, m.facts_review()).click());
    expect(root.textContent).toContain(`${evidence}/repaired`);
    await act(async () => button(root, m.facts_submit()).click());
    expect(commands).toHaveLength(2);
    expect(new Set(commands.map((command) => command.key)).size).toBe(2);
    expect(commands.map((command) => command.statement.property.id).sort()).toEqual([gender, keywords].sort());
    const keywordCommand = commands.find((command) => command.statement.property.id === keywords)!;
    expect(keywordCommand.statement.references[0]!.parts[0]!.value).toEqual({
      type: 'value',
      content: `${evidence}/repaired`,
    });
    expect(keywordCommand.statement.qualifiers).toEqual(statementInput(read.public.subject.statements[keywords]![0]!).qualifiers);
    expect(root.querySelector('#candidate-review')).toBeNull();
    const original = commands.find((command) => command.statement.property.id === keywords)!;
    await enter(field(root, gender).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/sibling-only`);
    expect(commands.find((command) => command.statement.property.id === keywords)).toBe(original);
    await act(async () => button(field(root, keywords), m.correction_review()).click());
    expect(reviews.at(-1)).toEqual({ property: keywords, session: 'character-session' });
    await act(async () => button(root, m.classification_read_current()).click());
    expect(root.textContent).toContain(m.facts_result_proposed());
    expect(root.textContent).toContain(m.facts_result_refused());
  });
});

test('failed current read, stale copy review and a removed holder diagnostic stay on that holder', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { CharacterClassifications } = await import('../src/features/catalogue/character-profile-classification');
    const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const { characterProfileFixture, characterProfileId } =
      await import('../src/kernel/fake/catalogue-character-profile');
    const fixture = characterProfileFixture();
    const read: FactsCurrent = {
      ok: true,
      public: fixture.character,
      release: structuredClone(fixture.release),
      source: null,
    };
    const seed = read.public.subject.statements['schema:height']![0]!;
    for (const field of [keywords, gender]) {
      read.public.subject.statements[field] = [
        {
          ...structuredClone(seed),
          id: `00000000-0000-4000-8000-${field === keywords ? '000000008001' : '000000008002'}`,
          property: { id: field, data_type: 'wikibase-item' },
          value: { type: 'value', content: concept },
          references: [
            {
              hash: 'copy',
              parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: evidence } }],
            },
          ],
        },
      ];
    }
    read.public.related[concept] = { type: 'skos:Concept', labels: { en: 'Concept' } };
    const transport = {
      ...fixture.props.facts(characterProfileId),
      propose: async () => ({ ok: false as const, reason: 'invalid' as const, errors: [{ pointer: '/statement/value', code: 'required' }] }),
      read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
    };
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: 'current' },
        h(CharacterClassifications, {
          changedSetReview: true,
          properties: [keywords, gender],
          read,
          locale: 'en',
          search: async () => [],
          transport,
          review: () => fixture.props.review(characterProfileId, keywords),
        }),
      ),
    );
    await act(async () => button(field(host, keywords), m.facts_edit_field()).click());
    await enter(field(host, keywords).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/keywords`);
    await act(async () => button(field(host, gender), m.facts_edit_field()).click());
    await enter(field(host, gender).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/gender`);
    await act(async () =>
      [...field(host, keywords).querySelectorAll('button')]
        .find((node) => node.textContent === m.facts_reuse_reference())!
        .click(),
    );
    await enter(field(host, keywords).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/stale`);
    expect(host.textContent).toContain(m.facts_reuse_stale());
    await act(async () => button(host, m.candidate_cancel()).click());
    await act(async () => button(host, m.facts_submit()).click());
    await act(async () => button(field(host, keywords), m.curation_view_discard()).click());
    await act(async () => button(field(host, keywords), m.curation_view_discard()).click());
    expect(host.textContent).toContain(m.classification_removed_holder());
    await enter(field(host, gender).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/after-read`);
    await act(async () => button(host, m.classification_read_current()).click());
    expect(host.textContent).toContain(m.classification_read_failed());
    expect(button(host, m.facts_submit()).disabled).toBe(true);
  });
});

test('unknown delivery keeps original bytes while a refused sibling is repaired, and subject replacement retires private work', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { CharacterClassifications } = await import('../src/features/catalogue/character-profile-classification');
    const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const { characterProfileFixture, characterProfileId } =
      await import('../src/kernel/fake/catalogue-character-profile');
    const fixture = characterProfileFixture();
    const read: FactsCurrent = {
      ok: true,
      public: fixture.character,
      release: structuredClone(fixture.release),
      source: null,
    };
    const seed = read.public.subject.statements['schema:height']![0]!;
    for (const field of [keywords, gender]) {
      read.public.subject.statements[field] = [
        {
          ...structuredClone(seed),
          id: `00000000-0000-4000-8000-${field === keywords ? '000000008001' : '000000008002'}`,
          property: { id: field, data_type: 'wikibase-item' },
          value: { type: 'value', content: concept },
          references: [
            {
              hash: 'unknown',
              parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: evidence } }],
            },
          ],
        },
      ];
    }
    read.public.related[concept] = { type: 'skos:Concept', labels: { en: 'Concept' } };
    const commands: FactCommand[] = [];
    const native = fixture.props.facts(characterProfileId);
    const transport = {
      ...native,
      propose: async (command: FactCommand) => {
        commands.push(command);
        return command.statement.property.id === keywords
          ? { ok: false as const, reason: 'uncertain' as const }
          : { ok: false as const, reason: 'denied' as const };
      },
    };
    const props = {
      changedSetReview: true,
      properties: [keywords, gender],
      read,
      locale: 'en',
      search: async () => [],
      transport,
      review: () => fixture.props.review(characterProfileId, keywords),
    };
    await render(
      h(CatalogueCurrentReading, { visible: true, ready: true, revision: 'current' }, h(CharacterClassifications, props)),
    );
    await act(async () => button(field(host, keywords), m.facts_edit_field()).click());
    await enter(field(host, keywords).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/keywords`);
    await act(async () => button(field(host, gender), m.facts_edit_field()).click());
    await enter(field(host, gender).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/gender`);
    await act(async () => button(host, m.facts_review()).click());
    await act(async () => button(host, m.facts_submit()).click());
    expect(commands).toHaveLength(2);
    const original = commands.find((command) => command.statement.property.id === keywords)!;
    await enter(field(host, gender).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/repaired`);
    expect(commands.filter((command) => command.statement.property.id === keywords)).toEqual([original]);
    await act(async () => button(field(host, keywords), m.correction_retry()).click());
    expect(commands.filter((command) => command.statement.property.id === keywords)).toEqual([original, original]);
    const next = structuredClone(read);
    next.public.subject.id = '00000000-0000-4000-8000-00000000c099';
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: 'replaced' },
        h(CharacterClassifications, { ...props, read: next }),
      ),
    );
    expect(host.textContent).not.toContain(`${evidence}/keywords`);
    expect(host.querySelector('[data-fact-reuse]')).toBeNull();
  });
});
