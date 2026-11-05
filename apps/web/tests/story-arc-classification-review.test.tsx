import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import type { FactCommand, FactsCurrent } from '../src/features/catalogue/subject-facts';
import type { CandidateTransport } from '../src/subject/candidate-review';
import { storyArcProfileFixture, storyArcProfileId } from '../src/kernel/fake/catalogue-story-arc-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

const genre = 'schema:genre';
const keywords = 'schema:keywords';
const concept = '00000000-0000-4000-8000-00000000c101';
const other = '00000000-0000-4000-8000-00000000c102';
const evidence = 'https://archive.example/story-arc';

function classified(): FactsCurrent {
  const fixture = storyArcProfileFixture();
  const read: FactsCurrent = { ok: true, public: fixture.arc, release: structuredClone(fixture.release), source: null };
  const seed = fixture.arc.subject.statements['schema:keywords']![0]!;
  const statement = (property: string, id: string, target: string, refs: boolean) => ({
    ...seed,
    id,
    property: { id: property, data_type: 'wikibase-item' as const },
    value: { type: 'value' as const, content: target },
    qualifiers: [
      {
        property: { id: 'rezics:spoilerLevel', data_type: 'quantity' as const },
        value: { type: 'value' as const, content: { amount: '+1', unit: '1' } },
      },
    ],
    references: refs
      ? [
          {
            hash: 'grouped',
            parts: [
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value' as const, content: evidence },
              },
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value' as const, content: `${evidence}/note` },
              },
            ],
          },
        ]
      : [],
    rank: 'preferred' as const,
  });
  read.public.subject.statements[genre] = [
    statement(genre, '00000000-0000-4000-8000-00000000c201', concept, true),
    statement(genre, '00000000-0000-4000-8000-00000000c211', other, false),
  ];
  read.public.subject.statements[keywords] = [
    statement(keywords, '00000000-0000-4000-8000-00000000c202', other, false),
  ];
  read.public.related[concept] = { type: 'skos:Concept', labels: { ja: '出典のジャンル' } };
  read.public.related[other] = { type: 'skos:Concept', labels: { en: 'Another concept' } };
  return read;
}

async function mounted(
  run: (page: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    enter: (input: HTMLInputElement, value: string) => Promise<void>;
    choose: (select: HTMLSelectElement, value: string) => Promise<void>;
    keyClick: (node: HTMLButtonElement) => Promise<void>;
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
      keyClick: async (node) => {
        await act(async () => {
          node.focus();
          node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
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

test('StoryArc classifications review, copy, repair by keyboard, and return independent native outcomes', async () => {
  await mounted(async ({ host, render, enter, choose, keyClick }) => {
    const { StoryArcClassificationReview } =
      await import('../src/features/catalogue/story-arc-classification-review-view');
    const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = storyArcProfileFixture();
    const read = classified();
    const commands: FactCommand[] = [];
    const native = fixture.props.facts(storyArcProfileId);
    const observed: unknown[] = [];
    const transport = {
      ...native,
      propose: async (command: FactCommand) => {
        commands.push(command);
        return command.statement.property.id === keywords
          ? { ok: false as const, reason: 'denied' as const }
          : native.propose(command);
      },
      read: async () => {
        const next = structuredClone(read);
        next.public.subject.statements[genre] = [
          { ...read.public.subject.statements[genre]![0]!, value: { type: 'value', content: other } },
        ];
        return next;
      },
    };
    const reviews: { property: string; session?: string }[] = [];
    const review = (property: string, session?: string): CandidateTransport => {
      reviews.push({ property, session });
      return fixture.props.review(storyArcProfileId, property, session);
    };
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: 'current' },
        h(StoryArcClassificationReview, {
          read,
          locale: 'en',
          search: async () => [
            { id: concept, title: '出典のジャンル', types: ['skos:Concept'], typeLabel: 'Concept', cover: null },
          ],
          transport,
          review,
          observe: (next) => observed.push(next),
        }),
      ),
    );
    expect(host.textContent).toContain(m.story_arc_classification());
    expect(host.textContent).toContain(concept);
    expect(host.textContent).not.toContain(fixture.work.publicRead.subject.id);
    await choose(
      field(host, genre).querySelector<HTMLSelectElement>('select')!,
      read.public.subject.statements[genre]![0]!.id,
    );
    await keyClick(button(field(host, genre), m.facts_edit_field()));
    await enter(field(host, genre).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/edited`);
    await keyClick(button(field(host, keywords), m.facts_edit_field()));
    await act(async () =>
      [...field(host, genre).querySelectorAll('button')]
        .find((node) => node.textContent === m.facts_reuse_reference())!
        .click(),
    );
    await act(async () =>
      host
        .querySelector<HTMLElement>(
          '[data-fact-reuse] button[role="checkbox"], [data-fact-reuse] input[type="checkbox"]',
        )!
        .click(),
    );
    await keyClick(button(host, m.facts_reuse_apply()));
    expect(field(host, keywords).querySelectorAll('input[type="url"]').length).toBeGreaterThan(0);
    await keyClick(button(host, m.facts_review_open_field()));
    expect(host.textContent).toContain(m.facts_review_stale());
    await enter(field(host, genre).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/repaired`);
    await keyClick(button(host, m.facts_review()));
    expect(host.textContent).toContain(`${evidence}/repaired`);
    await keyClick(button(host, m.facts_submit()));
    expect(commands).toHaveLength(2);
    expect(new Set(commands.map((command) => command.key)).size).toBe(2);
    const original = commands.find((command) => command.statement.property.id === genre)!;
    expect(original.statement.references[0]!.parts[0]!.value).toEqual({
      type: 'value',
      content: `${evidence}/repaired`,
    });
    expect(host.querySelector('#candidate-review')).toBeNull();
    await enter(
      field(host, keywords).querySelector<HTMLInputElement>('input[type="url"]')!,
      `${evidence}/sibling-only`,
    );
    expect(commands.find((command) => command.statement.property.id === genre)).toBe(original);
    await keyClick(button(field(host, genre), m.correction_review()));
    expect(reviews.at(-1)?.property).toBe(genre);
    await keyClick(button(host, m.classification_read_current()));
    expect(observed.at(-1)).toMatchObject({ ok: true });
    expect(host.textContent).toContain(m.facts_result_proposed());
    expect(host.textContent).toContain(m.facts_result_refused());
  });
});

test('unknown delivery, removed-holder diagnostics and current-read denial stay on that holder', async () => {
  await mounted(async ({ host, render, enter, keyClick }) => {
    const { StoryArcClassificationReview } =
      await import('../src/features/catalogue/story-arc-classification-review-view');
    const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = storyArcProfileFixture();
    const read = classified();
    const commands: FactCommand[] = [];
    const transport = {
      ...fixture.props.facts(storyArcProfileId),
      propose: async (command: FactCommand) => {
        commands.push(command);
        return command.statement.property.id === genre
          ? { ok: false as const, reason: 'uncertain' as const }
          : {
              ok: false as const,
              reason: 'invalid' as const,
              errors: [{ pointer: '/statement/value', code: 'required' }],
            };
      },
      read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
    };
    await render(
      h(
        CatalogueCurrentReading,
        { visible: true, ready: true, revision: 'current' },
        h(StoryArcClassificationReview, {
          read,
          locale: 'en',
          search: async () => [],
          transport,
          review: () => fixture.props.review(storyArcProfileId, genre),
          observe: () => {},
        }),
      ),
    );
    await keyClick(button(field(host, genre), m.facts_edit_field()));
    await enter(field(host, genre).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/genre`);
    await keyClick(button(field(host, keywords), m.facts_edit_field()));
    await enter(field(host, keywords).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/keywords`);
    await keyClick(button(host, m.facts_review()));
    await keyClick(button(host, m.facts_submit()));
    const original = commands.find((command) => command.statement.property.id === genre)!;
    await enter(field(host, keywords).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/repaired`);
    expect(commands.filter((command) => command.statement.property.id === genre)).toEqual([original]);
    await keyClick(button(field(host, genre), m.correction_retry()));
    expect(commands.filter((command) => command.statement.property.id === genre)).toEqual([original, original]);
    await keyClick(button(field(host, keywords), m.curation_view_discard()));
    await keyClick(button(field(host, keywords), m.curation_view_discard()));
    expect(host.textContent).toContain(m.classification_removed_holder());
    await keyClick(button(host, m.classification_read_current()));
    expect(host.textContent).toContain(m.classification_read_failed());
  });
});
