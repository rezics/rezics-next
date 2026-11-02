import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, useState, type ReactNode } from 'react';
import { sealFacts, stageFact, type FactCommand, type FactDraft } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));

// Authored UNRUN under MINIMAL. A mounted DOM proves neither browser geometry nor native acceptance.
async function mounted(
  run: (page: {
    host: HTMLElement;
    render: (node: ReactNode, retain?: boolean) => Promise<void>;
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
    'HTMLInputElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
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
      render: async (node, retain = false) => {
        if (!retain) generation++;
        await act(async () => root.render(h('div', { key: generation }, node)));
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
function include(region: Element) {
  const control = region.querySelector<HTMLElement>('[data-slot="checkbox"]')!;
  expect(control).not.toBeNull();
  const input = control.parentElement!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(input).not.toBeNull();
  const label = [...region.querySelectorAll<HTMLLabelElement>('label')].find((node) => node.htmlFor === input.id)!;
  expect(label).toBeDefined();
  expect(region.ownerDocument.getElementById(label.htmlFor)).toBe(input);
  expect(control.getAttribute('aria-labelledby')?.split(' ')).toContain(label.id);
  return { control, input, label };
}

test('Complete Subject facts family: same-property mounted FactFields keep independent source, draft and inclusion controls', async () => {
  await mounted(async ({ host, render, choose, enter }) => {
    const { FactField } = await import('../src/features/catalogue/subject-facts-view');
    const { stageFact } = await import('../src/features/catalogue/subject-facts');
    const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
    const { identifiersProfileFixture, identifiersCitation } =
      await import('../src/kernel/fake/catalogue-identifiers-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const require = createRequire(import.meta.url);
    const { default: userEvent } = await import(
      createRequire(require.resolve('storybook/test')).resolve('@testing-library/user-event')
    );
    const user = userEvent.setup({ document: host.ownerDocument });
    const fixture = identifiersProfileFixture();
    const read = await fixture.transport.read();
    if (!read.ok) throw new Error('Expected current identifier evidence');
    const property = 'schema:sameAs';
    const first = read.public.subject.statements[property]![0]!;
    const second = structuredClone(first);
    second.id = '00000000-0000-4000-8000-00000000d113';
    const longValue =
      'https://catalogue.example/editions/' +
      'original-unabridged-edition-'.repeat(12) +
      '?record=A%2Fb&lang=ja#complete';
    const citation = 'https://archive.example/records/second-edition?scan=original%2Fpage-24#citation';
    second.value = { type: 'value', content: longValue };
    second.qualifiers = [
      {
        property: { id: 'schema:name', data_type: 'monolingualtext' },
        value: { type: 'value', content: { text: 'Édition originale intégrale', language: 'fr' } },
      },
    ];
    second.references[0]!.parts[0]!.value = { type: 'value', content: citation };
    read.public.subject.statements[property]!.push(second);
    const before = structuredClone(read.public);
    const initialCalls = structuredClone(fixture.calls);
    const stages: (string | null)[][] = [[], []];
    const edits: FactDraft[][] = [[], []];
    let deliver!: () => void;
    function Pair({ mode = 'normal' }: { mode?: string }) {
      const [drafts, setDrafts] = useState<(FactDraft | undefined)[]>([
        mode === 'initial' ? stageFact(read, property, first.id)! : undefined,
        undefined,
      ]);
      const [phase, setPhase] = useState('current');
      deliver = () => setDrafts([stageFact(read, property, first.id)!, undefined]);
      return (
        <CatalogueCurrentReading visible ready={phase !== 'retired'} revision={phase}>
          <button type="button">Other</button>
          {[0, 1].map((index) => (
            <FactField
              key={mode === 'replaced' ? `${phase}:${index}` : index}
              property={property}
              read={read}
              locale="en"
              href="/en/subjects/edition"
              busy={false}
              canStage={true}
              draft={drafts[index]}
              onReview={() => {
                throw new Error('Unexpected review');
              }}
              onStage={(source) => {
                stages[index]!.push(source);
                if (mode === 'rejected') return;
                if (mode === 'moved') button(host, 'Other').focus();
                if (mode === 'retired' || mode === 'replaced') setPhase(mode);
                setDrafts((previous) =>
                  previous.map((draft, slot) => (slot === index ? stageFact(read, property, source)! : draft)),
                );
              }}
              onChange={(next) => {
                edits[index]!.push(next);
                setDrafts((previous) => previous.map((draft, slot) => (slot === index ? next : draft)));
              }}
            />
          ))}
        </CatalogueCurrentReading>
      );
    }
    await render(<Pair />);
    const fields = [...host.querySelectorAll<HTMLElement>('section[aria-label="exact match"]')];
    expect(fields).toHaveLength(2);
    const selects = fields.map((field) => field.querySelector<HTMLSelectElement>('select')!);
    expect(selects[0]!.id).not.toBe(selects[1]!.id);
    for (const [index, select] of selects.entries()) {
      expect(fields[index]!.querySelector(`label[for="${select.id}"]`)?.textContent).toBe(m.facts_choose_value());
      expect([...select.options].map((option) => option.value)).toEqual(['', first.id, second.id]);
      expect(button(fields[index]!, m.facts_edit_field()).disabled).toBe(true);
      const current = fields[index]!.querySelector('section')!;
      expect(current.querySelector('h4[data-content-item-slot="title"]')?.textContent).toBe(m.candidate_current());
      const evidence = [...current.querySelectorAll(':scope > ol > li')];
      expect(evidence).toHaveLength(2);
      expect(evidence.map((node) => node.querySelector('p')?.textContent)).toEqual([
        m.facts_selected_value({ number: 1 }),
        m.facts_selected_value({ number: 2 }),
      ]);
      expect(evidence[1]!.textContent).toContain(longValue);
      expect(evidence[1]!.querySelector('dl [lang="fr"]')?.textContent).toBe('Édition originale intégrale');
      expect(
        [...evidence[1]!.querySelectorAll<HTMLAnchorElement>('a')].map((node) => node.getAttribute('href')),
      ).toEqual([longValue, citation]);
      expect(evidence[1]!.querySelector('ul [lang="ja"]')?.textContent).toBe('原本の書誌');
      expect(current.querySelector('a a, a button, [data-slot="list-row-link"]')).toBeNull();
    }
    await choose(selects[1]!, second.id);
    expect(selects[0]!.value).toBe('');
    expect(button(fields[0]!, m.facts_edit_field()).disabled).toBe(true);
    expect(stages).toEqual([[], []]);
    await choose(selects[0]!, first.id);
    const opener = button(fields[0]!, m.facts_edit_field());
    opener.focus();
    await act(async () => user.keyboard('{Enter}'));
    const privateHeading = fields[0]!.querySelector('h4[tabindex="-1"]');
    expect(host.ownerDocument.activeElement).toBe(privateHeading);
    expect(fields[1]!.querySelector('select')).toBe(selects[1]);
    await act(async () => button(fields[1]!, m.facts_edit_field()).click());
    expect(host.ownerDocument.activeElement).toBe(privateHeading);
    expect(stages).toEqual([[first.id], [second.id]]);
    const controls = fields.map(include);
    expect(controls[0]!.input.id).not.toBe(controls[1]!.input.id);
    expect(new Set([...host.querySelectorAll('[id]')].map((node) => node.id)).size).toBe(
      host.querySelectorAll('[id]').length,
    );
    for (const { control, label } of controls) {
      expect(label.textContent).toBe(m.facts_include());
      expect(control.getAttribute('aria-checked')).toBe('true');
      expect(control.classList.contains('size-11')).toBe(true);
      expect(label.classList.contains('min-h-11')).toBe(true);
    }
    await act(async () => controls[1]!.label.click());
    expect(include(fields[0]!).control.getAttribute('aria-checked')).toBe('true');
    expect(include(fields[1]!).control.getAttribute('aria-checked')).toBe('false');
    expect(edits[0]).toEqual([]);
    expect(edits[1]!.at(-1)?.included).toBe(false);
    const valueInputs = fields.map((field) =>
      field.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!,
    );
    expect(valueInputs[0]!.value).toBe(identifiersCitation);
    expect(valueInputs[1]!.value).toBe(longValue);
    const changedValue = 'https://catalogue.example/explicit-private-draft';
    await enter(valueInputs[1]!, changedValue);
    expect(edits[1]!.at(-1)?.statement.value).toEqual({ type: 'value', content: changedValue });
    expect(valueInputs[0]!.value).toBe(identifiersCitation);
    expect(fields[1]!.querySelector('section')!.textContent).not.toContain(changedValue);
    expect(fields[1]!.querySelector('section')!.textContent).toContain(longValue);
    expect(include(fields[1]!).input.id).toBe(controls[1]!.input.id);
    await act(async () => controls[0]!.label.click());
    expect(include(fields[0]!).control.getAttribute('aria-checked')).toBe('false');
    expect(include(fields[1]!).control.getAttribute('aria-checked')).toBe('false');
    expect(read.public).toEqual(before);
    expect(fixture.calls).toEqual(initialCalls);
    for (const mode of ['add', 'pointer', 'rejected', 'moved', 'retired', 'replaced', 'initial']) {
      await render(<Pair mode={mode} />);
      const heading = () => host.querySelector('h4[tabindex="-1"]');
      if (mode !== 'initial') {
        const opener = button(host, m.facts_add_value());
        opener.focus();
        await act(async () => {
          opener.dispatchEvent(
            new host.ownerDocument.defaultView!.MouseEvent('click', {
              bubbles: true,
              detail: mode === 'pointer' ? 1 : 0,
            }),
          );
        });
        expect(host.ownerDocument.activeElement === heading()).toBe(mode === 'add');
        if (mode === 'rejected') {
          expect(host.ownerDocument.activeElement).toBe(opener);
          await act(async () => deliver());
          expect(host.ownerDocument.activeElement).not.toBe(heading());
        }
      } else expect(host.ownerDocument.activeElement).not.toBe(heading());
      button(host, 'Other').focus();
      await render(<Pair mode={mode} />, true);
      expect(host.ownerDocument.activeElement).toBe(button(host, 'Other'));
    }
  });
});

test('Actual repeated SubjectFacts workspaces stage and include only their own field, without extra reads or proposals', async () => {
  await mounted(async ({ host, render, choose }) => {
    const { SubjectFacts } = await import('../src/features/catalogue/subject-facts-view');
    const { subjectFactsFixture } = await import('../src/kernel/fake/subject-facts');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = subjectFactsFixture();
    const read = await fixture.transport.read();
    if (!read.ok) throw new Error('Expected current facts');
    const before = structuredClone(read.public);
    const calls = structuredClone(fixture.date.calls);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
    expect(fixture.language.calls).toEqual([]);
    await render(
      <>
        {[0, 1].map((index) => (
          <SubjectFacts key={index} initial={read} locale="en" transport={fixture.transport} review={fixture.review} />
        ))}
      </>,
    );
    const workspaces = [...host.querySelectorAll<HTMLElement>('article')];
    expect(workspaces).toHaveLength(2);
    const label = read.release.properties['schema:inLanguage']!.labels.en;
    const fields = workspaces.map((workspace) =>
      workspace.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!,
    );
    const selected = read.public.subject.statements['schema:inLanguage']!;
    await choose(fields[1]!.querySelector('select')!, selected[1]!.id);
    await act(async () => button(fields[1]!, m.facts_edit_field()).click());
    expect(fields[0]!.querySelector('[data-slot="checkbox"]')).toBeNull();
    await choose(fields[0]!.querySelector('select')!, selected[0]!.id);
    await act(async () => button(fields[0]!, m.facts_edit_field()).click());
    const first = include(fields[0]!);
    const second = include(fields[1]!);
    expect(first.input.id).not.toBe(second.input.id);
    await act(async () => first.label.click());
    expect(first.control.getAttribute('aria-checked')).toBe('false');
    expect(second.control.getAttribute('aria-checked')).toBe('true');
    expect(
      fields.map(
        (field) => field.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!.value,
      ),
    ).toEqual(['en', 'fr']);
    for (const workspace of workspaces) {
      expect(button(workspace, m.facts_submit()).disabled).toBe(true);
      expect(workspace.querySelector('form h2[data-content-item-slot="title"]')).not.toBeNull();
    }
    expect(fixture.date.calls).toEqual(calls);
    expect(fixture.language.calls).toEqual([]);
    expect(read.public).toEqual(before);
  });
});

test('Selected evidence keeps special assertions, ordered qualifiers and every reference part visible', async () => {
  await mounted(async ({ host, render }) => {
    const { SelectedFacts } = await import('../src/features/catalogue/subject-facts-view');
    const { identifiersProfileFixture, identifiersCitation } =
      await import('../src/kernel/fake/catalogue-identifiers-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = identifiersProfileFixture();
    const read = await fixture.transport.read();
    if (!read.ok) throw new Error('Expected current identifier evidence');
    const property = 'schema:sameAs';
    const original = read.public.subject.statements[property]![0]!;
    const unknown = structuredClone(original);
    unknown.id = '00000000-0000-4000-8000-00000000d114';
    unknown.value = { type: 'somevalue' };
    const absent = structuredClone(original);
    absent.id = '00000000-0000-4000-8000-00000000d115';
    absent.value = { type: 'novalue' };
    absent.qualifiers = [
      {
        property: { id: 'schema:name', data_type: 'monolingualtext' },
        value: { type: 'value', content: { text: 'Première édition', language: 'fr' } },
      },
      {
        property: { id: 'schema:name', data_type: 'monolingualtext' },
        value: { type: 'value', content: { text: '原版', language: 'ja' } },
      },
    ];
    const additional = structuredClone(absent.references[0]!);
    const citation = 'https://archive.example/second?exact=A%2Fb#reference';
    additional.parts[0]!.value = { type: 'value', content: citation };
    absent.references.push(additional);
    read.public.subject.statements[property] = [original, unknown, absent];
    const before = structuredClone(read.public);
    const calls = structuredClone(fixture.calls);
    await render(<SelectedFacts property={property} read={read} locale="en" />);
    const items = [...host.querySelectorAll('section > ol > li')];
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual(
      [1, 2, 3].map((number) => m.facts_selected_value({ number })),
    );
    expect(items[1]!.textContent).toContain(m.subject_value_unknown());
    expect(items[2]!.textContent).toContain(m.subject_value_none());
    expect(
      [...items[2]!.querySelectorAll('dd [lang]')].map((part) => [part.getAttribute('lang'), part.textContent]),
    ).toEqual([
      ['fr', 'Première édition'],
      ['ja', '原版'],
    ]);
    const references = [...items[2]!.querySelectorAll('ol > li')];
    expect(references.map((reference) => reference.querySelector('p')?.textContent)).toEqual([
      `${m.correction_references()} 1`,
      `${m.correction_references()} 2`,
    ]);
    expect(references.map((reference) => reference.querySelector('a')?.getAttribute('href'))).toEqual([
      identifiersCitation,
      citation,
    ]);
    expect(references.map((reference) => reference.querySelector('[lang="ja"]')?.textContent)).toEqual([
      '原本の書誌',
      '原本の書誌',
    ]);
    expect(host.querySelector('input, button, [data-slot="list-row-link"]')).toBeNull();
    expect(read.public).toEqual(before);
    expect(fixture.calls).toEqual(calls);
  });
});

test('Mounted field outcomes preserve separate partial results and the exact original uncertain command and native request bounds', async () => {
  await mounted(async ({ host, render, choose, enter }) => {
    const { SubjectFacts } = await import('../src/features/catalogue/subject-facts-view');
    const { subjectFactsFixture } = await import('../src/kernel/fake/subject-facts');
    const { m } = await import('../src/paraglide/messages.js');
    for (const scenario of ['partial', 'lost-response'] as const) {
      const fixture = subjectFactsFixture(scenario);
      const read = await fixture.transport.read();
      if (!read.ok) throw new Error('Expected current facts');
      const before = structuredClone(read.public);
      const commands: FactCommand[] = [];
      await render(
        <SubjectFacts
          initial={read}
          locale="en"
          review={fixture.review}
          transport={{
            read: fixture.transport.read,
            propose: (command) => {
              commands.push(command);
              return fixture.transport.propose(command);
            },
          }}
        />,
      );
      const field = (property: string) =>
        host.querySelector<HTMLElement>(`section[aria-label="${read.release.properties[property]!.labels.en}"]`)!;
      const date = field('schema:datePublished');
      const language = field('schema:inLanguage');
      await act(async () => button(date, m.facts_edit_field()).click());
      await enter(date.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_year()}"]`)!, '1946');
      await choose(language.querySelector('select')!, read.public.subject.statements['schema:inLanguage']![0]!.id);
      await act(async () => button(language, m.facts_edit_field()).click());
      await enter(language.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_value()}"]`)!, 'de');
      expect(commands).toEqual([]);
      await act(async () => button(host, m.facts_submit()).click());
      expect(commands).toHaveLength(2);
      expect(read.public).toEqual(before);
      const submitted = structuredClone(commands);
      if (scenario === 'partial') {
        expect(host.textContent).toContain(m.facts_results({ count: 1 }));
        expect(language.textContent).toContain(m.correction_denied());
        expect(date.textContent).toContain(m.correction_proposed());
        expect(date.querySelector('[data-slot="checkbox"]')).toBeNull();
      } else {
        expect(host.textContent?.split(m.facts_uncertain())).toHaveLength(3);
        for (const region of [date, language]) {
          expect(include(region).control.getAttribute('aria-disabled')).toBe('true');
          expect(
            [...region.querySelectorAll<HTMLInputElement>('input[aria-label]')].every((input) => input.disabled),
          ).toBe(true);
        }
        expect(host.querySelector('a[href*="candidate="]')).toBeNull();
      }
      await act(async () => button(host, m.facts_submit()).click());
      expect(commands).toHaveLength(scenario === 'partial' ? 3 : 4);
      expect(commands.slice(0, 2)).toEqual(submitted);
      for (const command of commands.slice(2)) {
        const original = commands.find((item) => item.statement.property.id === command.statement.property.id)!;
        expect(command).toBe(original);
        expect(command).toEqual(
          submitted.find((item) => item.statement.property.id === command.statement.property.id)!,
        );
      }
      if (scenario === 'lost-response') expect(host.textContent).toContain(m.facts_results({ count: 2 }));
      for (const slot of [fixture.date, fixture.language]) {
        const writes = slot.calls.filter((call) => call.method === 'POST');
        expect(writes).toHaveLength(scenario === 'partial' && slot === fixture.date ? 1 : 2);
        const original = commands.find((command) => command.statement.property.id === slot.address.property)!;
        for (const write of writes) {
          expect(write.path).toBe(`/v1/subjects/${slot.id}/candidates`);
          expect(write.authorization).toBe('Bearer fixture');
          expect(write.session).toBe(original.session ?? null);
          expect(write.key).toBe(original.key);
          expect(write.body).toEqual({ statement: original.statement });
        }
        expect(slot.calls.filter((call) => call.method === 'GET')).toHaveLength(slot === fixture.date ? 3 : 0);
        expect(slot.candidate.decision).toBeNull();
      }
      expect(read.public).toEqual(before);
      expect(host.querySelector('a a, a button')).toBeNull();
    }
  });
});

test('A withdrawn fact source needs an explicit replacement, including after an empty refresh', async () => {
  await mounted(async ({ host, render, choose }) => {
    const { FactField } = await import('../src/features/catalogue/subject-facts-view');
    const { identifiersProfileFixture } = await import('../src/kernel/fake/catalogue-identifiers-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const read = await identifiersProfileFixture().transport.read();
    if (!read.ok) throw new Error('Expected current facts');
    const property = 'schema:sameAs';
    const replacement = {
      ...read.public.subject.statements[property]![0]!,
      id: crypto.randomUUID(),
      value: { type: 'value' as const, content: '' },
    };
    const staged: (FactDraft | null)[] = [];
    const field = () =>
      h(FactField, {
        property,
        read,
        locale: 'en',
        busy: false,
        canStage: true,
        href: '/en/subjects/edition',
        onReview() {},
        onChange() {},
        onStage: (source) => staged.push(stageFact(read, property, source)),
      });
    await render(field());
    const edit = () => button(host, m.facts_edit_field());
    read.public.subject.statements[property] = [];
    await render(field(), true);
    expect(edit().disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.facts_source_unavailable());
    read.public.subject.statements[property] = [replacement];
    await render(field(), true);
    expect([host.querySelector<HTMLSelectElement>('select')!.value, edit().disabled, staged.length]).toEqual([
      '',
      true,
      0,
    ]);
    await choose(host.querySelector('select')!, replacement.id);
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => edit().click());
    expect(staged[0]?.source).toBe(replacement.id);
    expect(staged[0]?.baseline?.value).toEqual(replacement.value);
  });
});

test('Mounted fact correction links quantity and nested violations, clears revised feedback, and falls back for stale parts', async () => {
  await mounted(async ({ host, render, enter }) => {
    const { FactField } = await import('../src/features/catalogue/subject-facts-view');
    const { mangaFixture, mangaVolumeId } = await import('../src/kernel/fake/catalogue-manga-profile');
    const { readMangaProfile } = await import('../src/features/catalogue/manga-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = mangaFixture();
    const read = await readMangaProfile(fixture.client, mangaVolumeId);
    if (!read.ok || !read.public) throw new Error('Expected current Manga volume');
    const property = 'schema:numberOfPages';
    read.release.properties[property]!.qualifiers = ['schema:position'];
    const source = read.public.subject.statements[property]![0]!;
    const draft = stageFact(read, property, source.id)!;
    draft.statement.value = { type: 'value', content: { amount: '+bad', unit: '1' } };
    draft.statement.qualifiers = [{ property: { id: 'schema:position' }, value: { type: 'value', content: '' } }];
    draft.statement.references[0]!.parts[0]!.value = { type: 'value', content: 'not-a-url' };
    const [sealed] = sealFacts(mangaVolumeId, read.release, [draft]);
    if (!sealed || sealed.result?.ok !== false || sealed.result.reason !== 'invalid')
      throw new Error('Expected precise fact violations');
    let current: FactDraft = {
      ...sealed,
      result: {
        ...sealed.result,
        errors: [
          ...(sealed.result.errors ?? []),
          { pointer: '/statement/qualifiers/7/value/content', code: 'invalid_format' as const },
        ],
      },
    };
    const field = () =>
      h(FactField, {
        property,
        read,
        locale: 'en',
        draft: current,
        busy: false,
        canStage: true,
        href: `/en/subjects/${mangaVolumeId}/volume-2`,
        onStage() {},
        onChange: (next) => (current = next),
        onReview() {},
      });
    const control = (label: string) => {
      const node = [...host.querySelectorAll('label')].find((item) => item.textContent?.trim() === label)!;
      return host.ownerDocument.getElementById(node.htmlFor) as HTMLInputElement;
    };
    await render(field());
    const summary = () => host.querySelector<HTMLUListElement>(`ul[aria-label="${m.correction_errors()}"]`)!;
    const amount = control(m.correction_amount());
    const errors = summary();
    const described = new Set([...errors.querySelectorAll('li')].map((item) => item.id));
    const invalid = [...host.querySelectorAll<HTMLElement>('[aria-invalid="true"]')];
    expect(invalid).toHaveLength(3);
    expect(invalid.every((item) => described.has(item.getAttribute('aria-describedby')!))).toBe(true);
    expect(errors.textContent).toContain(m.correction_error_quantity());
    expect(errors.textContent).toContain(m.correction_error_url());
    const amountLink = [...errors.querySelectorAll('a')].find((item) =>
      item.textContent?.includes(m.correction_amount()),
    )!;
    expect(amountLink.getAttribute('href')).toBe(`#${amount.id}`);
    await act(async () => amountLink.click());
    expect(host.ownerDocument.activeElement).toBe(amount);
    const fallback = [...summary().querySelectorAll('a')].find((item) => item.textContent === m.correction_qualifiers())!;
    const section = host.ownerDocument.getElementById(fallback.getAttribute('href')!.slice(1))!;
    expect(section.tagName).toBe('SECTION');
    expect(section.id).toContain('qualifiers');
    await enter(amount, '+192');
    await render(field(), true);
    expect(summary()).toBeNull();
    expect(control(m.correction_amount()).hasAttribute('aria-invalid')).toBe(false);
  });
});
