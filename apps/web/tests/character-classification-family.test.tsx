import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, useState, type ReactNode } from 'react';
import type { FactCommand, FactsCurrent } from '../src/features/catalogue/subject-facts';
import type { CandidateTransport } from '../src/subject/candidate-review';

mock.module('cloudflare:workers', () => ({ env: {} }));

// Authored UNRUN: mounted DOM assertions are not browser geometry or native acceptance.
async function mounted(
  run: (page: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    choose: (select: HTMLSelectElement, value: string) => Promise<void>;
    enter: (input: HTMLInputElement, value: string) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLFormElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'DocumentFragment',
    'Document',
    'ShadowRoot',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'matchMedia',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let generation = 0;
  try {
    await run({
      host,
      render: async (node) => {
        await act(async () => root.render(h('div', { key: ++generation }, node)));
      },
      choose: async (select, value) => {
        await act(async () => {
          select.value = value;
          select.dispatchEvent(new window.Event('change', { bubbles: true }));
        });
      },
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
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function button(region: Element, name: string) {
  const found = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
  expect(found).toBeDefined();
  return found!;
}

const property = 'schema:keywords';
const concept = '00000000-0000-4000-8000-00000000d101';
const replacement = '00000000-0000-4000-8000-00000000d102';
const evidence = 'https://archive.example/character/' + 'original-source-'.repeat(12) + '?record=A%2Fb#evidence';

test('discard changes locally, choose another source, and keep its pending or uncertain command for exact retry', async () => {
  await mounted(async ({ host, render, choose, enter }) => {
    const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
    const { m } = await import('../src/paraglide/messages.js');
    const setup = await supplied(2, 'uncertain');
    const sources = setup.read.public.subject.statements[property]!;
    sources[1]!.qualifiers.push({
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+0', unit: '1' } },
    });
    const gate = Promise.withResolvers<void>();
    const propose = setup.transport.propose;
    setup.transport.propose = async (command) => {
      await gate.promise;
      return propose(command);
    };
    await render(<CharacterClassification {...setup} property={property} locale="en" search={async () => []} />);
    const input = () => host.querySelector<HTMLInputElement>('fieldset input[type="url"]')!;
    await choose(host.querySelector('select')!, sources[0]!.id);
    await act(async () => button(host, m.facts_edit_field()).click());
    await enter(input(), evidence + 'draft');
    await act(async () => button(host, m.curation_view_discard()).click());
    expect(host.ownerDocument.activeElement).toBe(button(host, m.candidate_cancel()));
    expect(input().value).toBe(evidence + 'draft');
    await act(async () => button(host, m.curation_view_discard()).click());
    expect(host.ownerDocument.activeElement).toBe(host.querySelector('select'));
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('');
    expect(setup.fixture.calls).toEqual([]);
    await choose(host.querySelector('select')!, sources[1]!.id);
    await act(async () => button(host, m.facts_edit_field()).click());
    expect(host.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toBe(
      setup.read.public.related[replacement]!.labels.en!,
    );
    expect(button(host, m.correction_submit()).disabled).toBe(true);
    expect(input().value).toBe(evidence);
    await enter(input(), evidence + 'replacement');
    await act(async () => button(host, m.correction_submit()).click());
    expect(button(host, m.curation_view_discard()).disabled).toBe(true);
    await act(async () => gate.resolve());
    expect(button(host, m.curation_view_discard()).disabled).toBe(true);
    await act(async () => button(host, m.curation_view_discard()).click());
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(host.textContent).toContain(m.facts_uncertain());
    const { statementInput } = await import('../src/features/catalogue/statement-editor');
    const expected = statementInput(sources[1]!);
    expected.references[0]!.parts[0]!.value = { type: 'value', content: evidence + 'replacement' };
    expect(setup.commands[0]!.statement).toEqual(expected);
    await act(async () => button(host, m.correction_retry()).click());
    expect(setup.commands[1]).toBe(setup.commands[0]);
    expect(host.textContent).toContain(m.correction_proposed());
  });
});

async function supplied(count = 1, scenario: 'ready' | 'uncertain' | 'denied' = 'ready') {
  const { characterProfileFixture, characterProfileId } =
    await import('../src/kernel/fake/catalogue-character-profile');
  const fixture = characterProfileFixture(scenario);
  const read: FactsCurrent = {
    ok: true,
    public: fixture.character,
    release: structuredClone(fixture.release),
    source: null,
  };
  const seed = read.public.subject.statements['schema:height']![0]!;
  for (const field of [property, 'schema:gender']) {
    read.public.subject.statements[field] = Array.from({ length: field === property ? count : 1 }, (_, index) => ({
      ...structuredClone(seed),
      id: `00000000-0000-4000-8000-${String(index + (field === property ? 800 : 900)).padStart(12, '0')}`,
      property: { id: field, data_type: 'wikibase-item' },
      value: { type: 'value' as const, content: index % 2 ? replacement : concept },
      references: [
        {
          hash: 'supplied-evidence',
          parts: [
            { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value' as const, content: evidence } },
          ],
        },
      ],
    }));
  }
  read.public.related[concept] = { type: 'skos:Concept', labels: { ja: '出典で明示された分類 — '.repeat(12) } };
  read.public.related[replacement] = { type: 'skos:Concept', labels: { en: 'Another supplied classification' } };
  const reviews: { property: string; session?: string }[] = [];
  const reads: { property?: string; session?: string }[] = [];
  const commands: FactCommand[] = [];
  const native = fixture.props.facts(characterProfileId);
  const transport = {
    ...native,
    propose: (command: FactCommand) => {
      commands.push(command);
      return native.propose(command);
    },
  };
  const review = (property: string, session?: string): CandidateTransport => {
    reviews.push({ property, session });
    const next = fixture.props.review(characterProfileId, property, session);
    return {
      ...next,
      read: (field, cursor, continuity = session, work) => {
        reads.push({ property: field, session: continuity });
        return next.read(field, cursor, continuity, work);
      },
    };
  };
  return { fixture, read, transport, review, reviews, reads, commands };
}

test('Character profile disclosure requires a settled successful read for its exact address', async () => {
  const { currentCharacterRead } = await import('../src/features/catalogue/character-profile');
  const read = { ok: true, character: { subject: { id: 'character' } }, work: { subject: { id: 'work' } } } as never;
  expect([
    currentCharacterRead(read, { id: 'character', work: 'work' }, false, false),
    currentCharacterRead(read, { id: 'character', work: 'work' }, true, false),
    currentCharacterRead(read, { id: 'character', work: 'work' }, false, true),
    currentCharacterRead(read, { id: 'other', work: 'work' }, false, false),
    currentCharacterRead(read, { id: 'character', work: 'other' }, false, false),
    currentCharacterRead({ ok: false, reason: 'unavailable' }, { id: 'character', work: 'work' }, false, false),
  ]).toEqual([true, false, false, false, false, false]);
});

test('empty, one and multiple current choices keep exact names, source baselines, labels and independent DOM addresses', async () => {
  await mounted(async ({ host, render, choose }) => {
    const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
    const { m } = await import('../src/paraglide/messages.js');
    for (const count of [0, 1, 2]) {
      const setup = await supplied(count);
      const props = { ...setup, property, locale: 'en', search: async () => [] };
      await render(
        <>
          <CharacterClassification {...props} />
          <CharacterClassification {...props} />
        </>,
      );
      const fields = [...host.querySelectorAll<HTMLElement>('main > div > section, div > section')].filter((section) =>
        section.querySelector('h3'),
      );
      expect(fields).toHaveLength(2);
      const selects = fields.map((field) => field.querySelector<HTMLSelectElement>('select'));
      if (count) {
        expect(selects[0]!.id).not.toBe(selects[1]!.id);
        for (const [index, field] of fields.entries()) {
          const label = field.querySelector<HTMLLabelElement>('label')!;
          expect(label.htmlFor).toBe(selects[index]!.id);
          expect(host.ownerDocument.getElementById(label.htmlFor)).toBe(selects[index]);
          expect(selects[index]!.getAttribute('aria-label')).toBe(m.facts_choose_value());
          expect([...selects[index]!.options].map((option) => [option.value, option.textContent])).toEqual([
            ['', m.correction_choose()],
            ...setup.read.public.subject.statements[property]!.map((statement, index) => [
              statement.id,
              m.facts_selected_value({ number: index + 1 }),
            ]),
          ]);
          expect(button(field, m.facts_edit_field()).disabled).toBe(count > 1);
        }
        await choose(selects[1]!, setup.read.public.subject.statements[property]![count - 1]!.id);
        expect(selects[0]!.value).toBe(count === 1 ? setup.read.public.subject.statements[property]![0]!.id : '');
      } else expect(selects).toEqual([null, null]);
      await act(async () => button(fields[1]!, m.facts_edit_field()).click());
      expect(fields[0]!.querySelector('fieldset')).toBeNull();
      expect(fields[1]!.textContent).toContain(m.facts_private());
      expect(fields[1]!.querySelector('h3[data-content-item-slot="title"]')).not.toBeNull();
      expect(fields[1]!.querySelector('h4[data-content-item-slot="title"]')).not.toBeNull();
      expect(button(fields[1]!, m.correction_submit()).disabled).toBe(count > 0);
      expect(fields[1]!.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!.value).toBe(
        count ? (count === 2 ? replacement : concept) : '',
      );
      expect(setup.fixture.calls).toEqual([]);
      expect(setup.reads).toEqual([]);
      expect(host.querySelector('[data-slot="list-row-link"], a button, a input')).toBeNull();
    }
  });
});

test('multivalued Add stages a blank private value; current Edit preserves full supplied fallback title and evidence', async () => {
  await mounted(async ({ host, render }) => {
    const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
    const { m } = await import('../src/paraglide/messages.js');
    const setup = await supplied(2);
    setup.read.release.properties[property]!.labels = { ja: '物語で明示された分類と根拠の長い名前 — '.repeat(10) };
    const before = structuredClone(setup.read.public);
    const props = { ...setup, property, locale: 'en', search: async () => [] };
    await render(
      <div dir="rtl">
        <CharacterClassification {...props} />
      </div>,
    );
    expect(host.querySelector('h3')!.getAttribute('lang')).toBe('ja');
    expect(host.querySelector('h3')!.getAttribute('dir')).toBe('auto');
    expect(host.querySelector('h3')!.textContent).toBe(setup.read.release.properties[property]!.labels.ja!);
    await act(async () => button(host, m.facts_add_value()).click());
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toBe('');
    await render(<CharacterClassification {...props} />);
    await act(async () => button(host, m.facts_add_value()).click());
    // A single selected source is auto-chosen; its picker uses only supplied public related metadata.
    const single = await supplied();
    await render(<CharacterClassification {...props} read={single.read} />);
    await act(async () => button(host, m.facts_edit_field()).click());
    expect(host.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toBe(
      single.read.public.related[concept]!.labels.ja!,
    );
    expect([...host.querySelectorAll<HTMLInputElement>('input')].some((input) => input.value === evidence)).toBe(true);
    expect(button(host, m.correction_submit()).disabled).toBe(true);
    delete single.read.public.related[concept];
    await render(<CharacterClassification {...props} read={single.read} />);
    await act(async () => button(host, m.facts_edit_field()).click());
    expect(host.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toBe(m.subject_value_unlabelled());
    expect(setup.read.public).toEqual(before);
    expect(setup.fixture.calls).toEqual([]);
  });
});

test('uncertain retry reuses the identical sealed command and key; only deliberate Review reads its exact candidate/session', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
    const { m } = await import('../src/paraglide/messages.js');
    const setup = await supplied(1, 'uncertain');
    const before = structuredClone(setup.read.public);
    await render(<CharacterClassification {...setup} property={property} locale="en" search={async () => []} />);
    await act(async () => button(host, m.facts_edit_field()).click());
    await enter(host.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!, replacement);
    await act(async () => button(host, m.correction_submit()).click());
    expect(setup.commands).toHaveLength(1);
    const original = structuredClone(setup.commands[0]!);
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(host.textContent).toContain(m.correction_unavailable());
    expect(setup.reads).toEqual([]);
    expect(host.querySelector('#candidate-review')).toBeNull();
    await act(async () => button(host, m.correction_retry()).click());
    expect(setup.commands).toHaveLength(2);
    expect(setup.commands[1]).toBe(setup.commands[0]);
    expect(setup.commands[1]).toEqual(original);
    const writes = setup.fixture.calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({
      method: 'POST',
      path: `/v1/subjects/${setup.read.public.subject.id}/candidates`,
      body: { statement: original.statement },
      key: original.key,
    });
    expect(original.statement.references[0]!.parts[0]!.value).toEqual({ type: 'value', content: evidence });
    expect(host.textContent).toContain(m.correction_proposed());
    expect(setup.fixture.candidates).toHaveLength(1);
    expect(setup.fixture.candidates[0]!.decision).toBeNull();
    expect(setup.read.public).toEqual(before);
    expect(setup.reads).toEqual([]);
    const result = setup.reviews.at(-1)!;
    expect(result).toEqual({ property, session: 'character-session' });
    const exact = setup.fixture.candidates[0]!;
    const decoy = structuredClone(exact);
    decoy.id = '00000000-0000-4000-8000-00000000d199';
    decoy.statement.id = decoy.id;
    decoy.statement.value = { type: 'value', content: concept };
    setup.fixture.candidates.unshift(decoy);
    await act(async () => button(host, m.correction_review()).click());
    expect(setup.reads).toEqual([{ property, session: 'character-session' }]);
    expect(host.querySelector('#candidate-review')).not.toBeNull();
    expect(host.textContent).toContain(m.candidate_proposed());
    const proposed = [...host.querySelectorAll('h4')].find(
      (heading) => heading.textContent === m.candidate_proposed(),
    )!.parentElement!;
    expect(proposed.textContent).toContain(setup.read.public.related[replacement]!.labels.en!);
    expect(proposed.textContent).not.toContain(setup.read.public.related[concept]!.labels.ja!);
    expect(host.querySelector(`#include-${exact.id}`)).not.toBeNull();
    expect(setup.fixture.calls.filter((call) => call.method === 'POST')).toEqual(writes);
    expect(setup.read.public).toEqual(before);
  });
});

test('actual picker admits exact and released base types, excludes unknown/ineligible targets and keeps each picker independent', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
    const { m } = await import('../src/paraglide/messages.js');
    for (const target of ['skos:Concept', 'schema:Thing']) {
      const setup = await supplied(0);
      // Both target and base edges are from the current release; no synthetic subtype is invented.
      setup.read.release.properties[property]!.targets = [target];
      const requests: { text: string; signal: AbortSignal }[] = [];
      const options = [
        { id: replacement, title: 'A valid supplied Concept', types: ['skos:Concept'], typeLabel: '', cover: null },
        { id: concept, title: 'Unknown type', types: ['absent:Type'], typeLabel: '', cover: null },
        {
          id: setup.fixture.work.id,
          title: 'A work, not a Concept',
          types: [setup.fixture.work.publicRead.subject.type],
          typeLabel: '',
          cover: null,
        },
      ];
      const search = async (text: string, signal: AbortSignal) => {
        requests.push({ text, signal });
        return options;
      };
      await render(
        <>
          <CharacterClassification {...setup} property={property} locale="en" search={search} />
          <CharacterClassification {...setup} property={property} locale="en" search={search} />
        </>,
      );
      const sections = [...host.querySelectorAll<HTMLElement>('section')];
      for (const section of sections) await act(async () => button(section, m.facts_edit_field()).click());
      const inputs = sections.map((section) => section.querySelector<HTMLInputElement>('[role="combobox"]')!);
      await act(async () => inputs[1]!.focus());
      await enter(inputs[1]!, 'supplied');
      // Wait for the real picker's existing debounce, not a substitute search implementation.
      for (let attempt = 0; attempt < 100 && !host.ownerDocument.querySelector('[role="option"]'); attempt++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      const shown = [...host.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(shown.some((option) => option.textContent?.includes('A valid supplied Concept'))).toBe(true);
      expect(shown.some((option) => option.textContent?.includes('Unknown type'))).toBe(false);
      expect(shown.some((option) => option.textContent?.includes('A work, not a Concept'))).toBe(
        target === 'schema:Thing',
      );
      await act(async () => shown.find((option) => option.textContent?.includes('A valid supplied Concept'))!.click());
      expect(inputs[0]!.value).toBe('');
      expect(inputs[1]!.value).toBe('A valid supplied Concept');
      expect(sections[1]!.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!.value).toBe(
        replacement,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]!.text).toBe('supplied');
      expect(setup.fixture.calls).toEqual([]);
      expect(setup.reads).toEqual([]);
    }
  });
});

test('unchanged connected CharacterProfile parent retires a pending classification result with its reader', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { CharacterProfile } = await import('../src/features/catalogue/character-profile-view');
    const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { m } = await import('../src/paraglide/messages.js');
    const setup = await supplied();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let finish!: (result: Awaited<ReturnType<typeof setup.transport.propose>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof setup.transport.propose>>>((resolve) => {
      finish = resolve;
    });
    function Parent() {
      const [retired, setRetired] = useState(false);
      return (
        <QueryClientProvider client={client}>
          <button onClick={() => setRetired(true)}>Retire illustrative reader</button>
          <CandidateReaderBoundary
            address="classification-parent"
            observed={{
              state: retired ? 'signed-out' : 'signed-in',
              subject: retired ? null : 'original-reader',
              csrfToken: retired ? null : 'fixture-csrf',
            }}
          >
            <CharacterProfile
              {...setup.fixture.props}
              id={setup.read.public.subject.id}
              locale="en"
              session={retired ? 'signed-out' : 'signed-in'}
              facts={() => ({ ...setup.transport, propose: () => pending })}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>
      );
    }
    try {
      await render(<Parent />);
      const field = () =>
        [...host.querySelectorAll('h3')]
          .find((heading) => heading.textContent === setup.read.release.properties[property]!.labels.en)
          ?.closest('section');
      for (let attempt = 0; attempt < 100 && !field(); attempt++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      expect(field()).toBeDefined();
      await act(async () => button(field()!, m.facts_edit_field()).click());
      await enter(
        field()!.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!,
        replacement,
      );
      await act(async () => button(field()!, m.correction_submit()).click());
      await act(async () => button(host, 'Retire illustrative reader').click());
      await act(async () =>
        finish({
          ok: true,
          kind: 'proposed-awaiting-review',
          candidate: '00000000-0000-4000-8000-00000000d198',
          revision: 2,
          session: 'old-private-session',
        }),
      );
      expect(host.textContent).not.toContain(m.correction_proposed());
      expect(host.querySelector('#candidate-review')).toBeNull();
      expect(setup.fixture.candidates).toEqual([]);
      expect(setup.reads).toEqual([]);
    } finally {
      await render(null);
      client.clear();
    }
  });
});

test('independent property proposal results and denied/stale/unavailable distinctions do not publish or open review', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
    const { m } = await import('../src/paraglide/messages.js');
    for (const fields of [
      [property, 'schema:gender'],
      [property, property],
    ]) {
      const setup = await supplied();
      const firstReplacement = '00000000-0000-4000-8000-00000000d103';
      setup.read.public.related[firstReplacement] = {
        type: 'skos:Concept',
        labels: { en: 'Independent first proposal' },
      };
      const before = structuredClone(setup.read.public);
      await render(
        <>
          {fields.map((field, index) => (
            <CharacterClassification key={index} {...setup} property={field} locale="en" search={async () => []} />
          ))}
        </>,
      );
      const regions = [...host.querySelectorAll<HTMLElement>('section')];
      for (const [index, region] of regions.entries()) {
        await act(async () => button(region, m.facts_edit_field()).click());
        await enter(
          region.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!,
          index === 0 ? firstReplacement : replacement,
        );
      }
      await act(async () => button(regions[1]!, m.correction_submit()).click());
      expect(regions[0]!.textContent).not.toContain(m.correction_proposed());
      await act(async () => button(regions[0]!, m.correction_submit()).click());
      expect(setup.commands.map((command) => command.statement.property.id)).toEqual([fields[1]!, fields[0]!]);
      expect(new Set(setup.commands.map((command) => command.key)).size).toBe(2);
      expect(setup.fixture.candidates.map((candidate) => candidate.statement.property.id)).toEqual([
        fields[1]!,
        fields[0]!,
      ]);
      expect(setup.reads).toEqual([]);
      for (const index of [1, 0]) {
        await act(async () => button(regions[index]!, m.correction_review()).click());
        expect(setup.reads.at(-1)).toEqual({ property: fields[index], session: 'character-session' });
        const exact = setup.fixture.candidates[1 - index]!;
        expect(regions[index]!.querySelector(`#include-${exact.id}`)).not.toBeNull();
        const proposed = [...regions[index]!.querySelectorAll('h4')].find(
          (heading) => heading.textContent === m.candidate_proposed(),
        )!.parentElement!;
        const titles = [
          setup.read.public.related[firstReplacement]!.labels.en!,
          setup.read.public.related[replacement]!.labels.en!,
        ];
        expect(proposed.textContent).toContain(titles[index]!);
        expect(proposed.textContent).not.toContain(titles[1 - index]!);
        if (index === 1) expect(regions[0]!.querySelector('#candidate-review')).toBeNull();
      }
      expect(setup.reads).toHaveLength(2);
      expect(setup.read.public).toEqual(before);
    }
    const setup = await supplied();
    const before = structuredClone(setup.read.public);
    for (const reason of ['denied', 'stale', 'unavailable'] as const) {
      await render(
        <CharacterClassification
          {...setup}
          property={property}
          locale="en"
          search={async () => []}
          transport={{ ...setup.transport, propose: async () => ({ ok: false, reason }) }}
        />,
      );
      await act(async () => button(host, m.facts_edit_field()).click());
      await enter(host.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!, replacement);
      await act(async () => button(host, m.correction_submit()).click());
      expect(host.querySelector('[role="alert"]')!.textContent).toBe(
        reason === 'denied'
          ? m.correction_denied()
          : reason === 'stale'
            ? m.correction_stale()
            : m.correction_unavailable(),
      );
      expect(host.querySelector('fieldset')!.disabled).toBe(reason === 'unavailable');
      expect(host.querySelector('#candidate-review')).toBeNull();
      expect(setup.read.public).toEqual(before);
    }
  });
});

test('supplied selected-value growth at 1/8/32 renders only bounded rows and performs zero IO', async () => {
  await mounted(async ({ host, render }) => {
    const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
    for (const count of [1, 8, 32]) {
      const setup = await supplied(count);
      let searches = 0;
      await render(
        <CharacterClassification
          {...setup}
          property={property}
          locale="en"
          search={async () => {
            searches++;
            return [];
          }}
        />,
      );
      expect(host.querySelectorAll('option')).toHaveLength(count + 1);
      expect(host.querySelectorAll('h3')).toHaveLength(1);
      expect(host.querySelectorAll('button')).toHaveLength(2);
      expect(setup.commands).toEqual([]);
      expect(setup.reads).toEqual([]);
      expect(setup.fixture.calls).toEqual([]);
      expect(searches).toBe(0);
    }
  });
});
