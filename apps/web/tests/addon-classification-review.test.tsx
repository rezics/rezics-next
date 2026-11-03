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

const platform = 'schema:gamePlatform';
const genre = 'schema:genre';
const evidence = 'https://archive.example/addon/original';
const genreId = '00000000-0000-4000-8000-00000000a106';

async function classified() {
  const { AddonClassifications } = await import('../src/features/catalogue/addon-classification-review-view');
  const { addonClassificationCurrent } = await import('../src/features/catalogue/addon-classification-review');
  const { m } = await import('../src/paraglide/messages.js');
  const { addonProfileFixture, addonPlatformId, addonProfileId, addonWorkId } =
    await import('../src/kernel/fake/catalogue-addon-profile');
  const fixture = addonProfileFixture();
  const loaded = addonClassificationCurrent({
    ok: true,
    release: fixture.release,
    public: fixture.current,
    work: fixture.work,
  });
  if (!loaded.ok) throw new Error('Expected add-on facts');
  const read = loaded;
  const seed = read.public.subject.statements['schema:inLanguage']![0]!;
  const statement = (
    property: string,
    id: string,
    target: string,
    extra: Record<string, unknown> = {},
  ) => ({
    ...structuredClone(seed),
    id,
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    references: [
      {
        hash: property,
        parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: evidence } }],
      },
    ],
    ...extra,
  });
  return { AddonClassifications, m, fixture, read, addonPlatformId, addonProfileId, addonWorkId, statement };
}

test('Add-on classifications review the changed set, copy evidence, repair a nested part, and return independent native outcomes', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { statementInput } = await import('../src/features/catalogue/statement-editor');
    const { addonBase } = await import('../src/features/catalogue/addon-profile');
    const { AddonClassifications, m, fixture, read, addonPlatformId, addonProfileId, addonWorkId, statement } =
      await classified();
    read.public.subject.statements[platform] = [
      statement(platform, '00000000-0000-4000-8000-00000000a111', addonPlatformId, {
        qualifiers: [
          { property: { id: 'schema:inLanguage', data_type: 'string' }, value: { type: 'value', content: 'ja' } },
        ],
        references: [
          {
            hash: 'grouped',
            parts: [
              { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: evidence } },
              { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: `${evidence}/note` } },
            ],
          },
        ],
      }),
    ];
    read.public.subject.statements[genre] = [
      statement(genre, '00000000-0000-4000-8000-00000000a112', genreId, { references: [] }),
    ];
    read.public.related[genreId] = { type: 'skos:Concept', labels: { en: 'Expansion genre' } };
    const membership = structuredClone(read.public.subject.statements[addonBase]);
    const commands: FactCommand[] = [];
    const native = fixture.props.facts(addonProfileId);
    const transport = {
      ...native,
      propose: async (command: FactCommand) => {
        commands.push(command);
        if (command.statement.property.id === genre) return { ok: false as const, reason: 'denied' as const };
        return native.propose(command);
      },
      read: async () => {
        const next = structuredClone(read);
        next.public.subject.statements[platform] = [
          { ...read.public.subject.statements[platform]![0]!, value: { type: 'value', content: genreId } },
        ];
        return next;
      },
    };
    const reviews: { property: string; session?: string }[] = [];
    const review = (property: string, session?: string): CandidateTransport => {
      reviews.push({ property, session });
      return fixture.props.review(addonProfileId, property, session);
    };
    await render(
      h(AddonClassifications, {
        read,
        locale: 'en',
        search: async () => [
          { id: addonPlatformId, title: 'Desktop platform', types: ['skos:Concept'], typeLabel: 'Concept', cover: null },
        ],
        transport,
        review,
      }),
    );
    expect(host.textContent).toContain(m.addon_classification_title());
    expect(host.textContent).toContain(m.addon_classification_independent());
    expect(host.textContent).toContain(addonPlatformId);
    expect(host.textContent).not.toContain(addonWorkId);
    await act(async () => button(field(host, platform), m.facts_edit_field()).click());
    await enter(field(host, platform).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/edited`);
    await act(async () => button(field(host, genre), m.facts_edit_field()).click());
    await act(async () =>
      [...field(host, platform).querySelectorAll('button')]
        .find((node) => node.textContent === m.facts_reuse_reference())!
        .click(),
    );
    const reusePanel = host.querySelector('[data-fact-reuse]')!;
    const check = reusePanel.querySelector<HTMLElement>('button[role="checkbox"], input[type="checkbox"]')!;
    await act(async () => check.click());
    await act(async () => button(host, m.facts_reuse_apply()).click());
    expect(field(host, genre).querySelectorAll('input[type="url"]').length).toBeGreaterThan(0);
    expect(host.textContent).toContain(m.classification_siblings_retained());
    await act(async () => button(host, m.facts_review_open_field()).click());
    expect(host.textContent).toContain(m.facts_review_stale());
    const nested = field(host, platform).querySelector<HTMLInputElement>('input[type="url"]')!;
    await enter(nested, `${evidence}/repaired`);
    await act(async () => button(host, m.facts_review()).click());
    expect(host.textContent).toContain(`${evidence}/repaired`);
    await act(async () => button(host, m.facts_submit()).click());
    expect(commands).toHaveLength(2);
    expect(new Set(commands.map((command) => command.key)).size).toBe(2);
    expect(commands.map((command) => command.statement.property.id).sort()).toEqual([genre, platform].sort());
    const platformCommand = commands.find((command) => command.statement.property.id === platform)!;
    expect(platformCommand.statement.references[0]!.parts[0]!.value).toEqual({
      type: 'value',
      content: `${evidence}/repaired`,
    });
    expect(platformCommand.statement.qualifiers).toEqual(
      statementInput(read.public.subject.statements[platform]![0]!).qualifiers,
    );
    expect(host.querySelector('#candidate-review')).toBeNull();
    const original = commands.find((command) => command.statement.property.id === platform)!;
    await enter(field(host, genre).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/sibling-only`);
    expect(commands.find((command) => command.statement.property.id === platform)).toBe(original);
    await act(async () => button(field(host, platform), m.correction_review()).click());
    expect(reviews.at(-1)).toEqual({ property: platform, session: 'addon-session' });
    await act(async () => button(host, m.classification_read_current()).click());
    expect(host.textContent).toContain(m.facts_result_proposed());
    expect(host.textContent).toContain(m.facts_result_refused());
    expect(JSON.stringify(read.public.subject.statements[addonBase])).toBe(JSON.stringify(membership));
  });
});

test('failed current add-on read, stale copy review and a removed holder diagnostic stay on that holder', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { AddonClassifications, m, fixture, read, addonPlatformId, addonProfileId, statement } = await classified();
    for (const fieldName of [platform, genre]) {
      read.public.subject.statements[fieldName] = [
        statement(
          fieldName,
          `00000000-0000-4000-8000-${fieldName === platform ? '00000000a111' : '00000000a112'}`,
          addonPlatformId,
        ),
      ];
    }
    const transport = {
      ...fixture.props.facts(addonProfileId),
      propose: async () => ({
        ok: false as const,
        reason: 'invalid' as const,
        errors: [{ pointer: '/statement/value', code: 'required' }],
      }),
      read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
    };
    await render(
      h(AddonClassifications, {
        read,
        locale: 'en',
        search: async () => [],
        transport,
        review: () => fixture.props.review(addonProfileId, platform),
      }),
    );
    await act(async () => button(field(host, platform), m.facts_edit_field()).click());
    await enter(field(host, platform).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/platform`);
    await act(async () => button(field(host, genre), m.facts_edit_field()).click());
    await enter(field(host, genre).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/genre`);
    await act(async () =>
      [...field(host, platform).querySelectorAll('button')]
        .find((node) => node.textContent === m.facts_reuse_reference())!
        .click(),
    );
    await enter(field(host, platform).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/stale`);
    expect(host.textContent).toContain(m.facts_reuse_stale());
    await act(async () => button(host, m.candidate_cancel()).click());
    await act(async () => button(host, m.facts_submit()).click());
    await act(async () => button(field(host, platform), m.curation_view_discard()).click());
    await act(async () => button(field(host, platform), m.curation_view_discard()).click());
    expect(host.textContent).toContain(m.classification_removed_holder());
    await enter(field(host, genre).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/after-read`);
    await act(async () => button(host, m.classification_read_current()).click());
    expect(host.textContent).toContain(m.classification_read_failed());
    expect(button(host, m.facts_submit()).disabled).toBe(true);
  });
});

test('unknown delivery keeps original bytes while a refused sibling is repaired, and subject replacement retires private work', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { AddonClassifications, m, fixture, read, addonPlatformId, addonProfileId, statement } = await classified();
    for (const fieldName of [platform, genre]) {
      read.public.subject.statements[fieldName] = [
        statement(
          fieldName,
          `00000000-0000-4000-8000-${fieldName === platform ? '00000000a111' : '00000000a112'}`,
          addonPlatformId,
        ),
      ];
    }
    const commands: FactCommand[] = [];
    const native = fixture.props.facts(addonProfileId);
    const transport = {
      ...native,
      propose: async (command: FactCommand) => {
        commands.push(command);
        return command.statement.property.id === platform
          ? { ok: false as const, reason: 'uncertain' as const }
          : { ok: false as const, reason: 'denied' as const };
      },
    };
    const props = {
      read,
      locale: 'en',
      search: async () => [],
      transport,
      review: () => fixture.props.review(addonProfileId, platform),
    };
    await render(h(AddonClassifications, props));
    await act(async () => button(field(host, platform), m.facts_edit_field()).click());
    await enter(field(host, platform).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/platform`);
    await act(async () => button(field(host, genre), m.facts_edit_field()).click());
    await enter(field(host, genre).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/genre`);
    await act(async () => button(host, m.facts_review()).click());
    await act(async () => button(host, m.facts_submit()).click());
    expect(commands).toHaveLength(2);
    const original = commands.find((command) => command.statement.property.id === platform)!;
    await enter(field(host, genre).querySelector<HTMLInputElement>('input[type="url"]')!, `${evidence}/repaired`);
    expect(commands.filter((command) => command.statement.property.id === platform)).toEqual([original]);
    await act(async () => button(field(host, platform), m.correction_retry()).click());
    expect(commands.filter((command) => command.statement.property.id === platform)).toEqual([original, original]);
    const next = structuredClone(read) as FactsCurrent;
    next.public.subject.id = '00000000-0000-4000-8000-00000000a099';
    await render(h(AddonClassifications, { ...props, read: next, revision: 'replaced' }));
    expect(host.textContent).not.toContain(`${evidence}/platform`);
    expect(host.querySelector('[data-fact-reuse]')).toBeNull();
  });
});
