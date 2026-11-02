import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useState, type ReactNode } from 'react';
import type { FactCommand, FactResult, FactsCurrent } from '../src/features/catalogue/subject-facts';
import { characterProfileFixture, characterProfileId } from '../src/kernel/fake/catalogue-character-profile';

mock.module('cloudflare:workers', () => ({ env: {} }));

async function mounted(run: (page: { host: HTMLElement; render: (node: ReactNode) => Promise<void> }) => Promise<void>) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
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
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function button(scope: ParentNode, label: string) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label);
  expect(found).toBeDefined();
  return found!;
}

test('classification holders share departure protection through recovery, retries and retirement', async () => {
  await mounted(async ({ host, render }) => {
    const { AuthoringDepartureBoundary, useAuthoringDeparture } = await import('../src/threads/authoring-departure');
    const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
    const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
    const { statementInput } = await import('../src/features/catalogue/statement-editor');
    const { characterFacts } = await import('../src/features/catalogue/character-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = characterProfileFixture();
    const loaded = await fixture.transport.load({ id: characterProfileId });
    if (!loaded.ok || !loaded.character) throw new Error('Expected the current Character');
    const read = characterFacts(loaded);
    if (!read.ok) throw new Error('Expected current Character facts');
    const property = 'schema:keywords';
    const target = read.release.properties[property]!.targets![0]!;
    const concept = '00000000-0000-4000-8000-00000000d101';
    const replacement = '00000000-0000-4000-8000-00000000d102';
    const seed = structuredClone(read.public.subject.statements['schema:height']![0]!);
    read.public.subject.statements[property] = [concept, replacement].map((id, index) => ({
      ...seed,
      id: `00000000-0000-4000-8000-00000000d18${index}`,
      property: { id: property, data_type: 'wikibase-item' },
      value: { type: 'value' as const, content: id },
      qualifiers: [
        {
          property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
          value: { type: 'value' as const, content: { amount: `+${index}`, unit: '1' } },
        },
      ],
      references: [
        {
          hash: `classification-source-${index}`,
          parts: [
            {
              property: { id: 'schema:url', data_type: 'url' },
              value: { type: 'value' as const, content: 'https://archive.example/classification' },
            },
          ],
        },
      ],
    }));
    read.public.related[concept] = { type: target, labels: { en: 'Original concept' } };
    read.public.related[replacement] = { type: target, labels: { en: 'Replacement concept' } };
    const native = fixture.props.facts(characterProfileId);
    const commands: FactCommand[] = [];
    let firstResult: FactResult | undefined;
    let finishFirst!: (result: FactResult) => void;
    const pending = new Promise<FactResult>((resolve) => (finishFirst = resolve));
    const transport = {
      ...native,
      propose: (command: FactCommand) => {
        commands.push(command);
        if (commands.length === 1) return pending;
        return native.propose(command).then((result) => ((firstResult = result), result));
      },
    };
    const search = async () =>
      [concept, replacement].map((id) => ({
        id,
        title: read.public.related[id]!.labels.en!,
        types: [target],
        typeLabel: target,
        cover: null,
      }));
    function DepartureButton({ proceed }: { proceed: () => void }) {
      const { requestNavigation } = useAuthoringDeparture(false, false, 'candidate-review');
      return (
        <button type="button" onClick={() => requestNavigation(proceed)}>
          Open candidate review
        </button>
      );
    }
    function Workspace({ ready }: { ready: boolean }) {
      const [visit, setVisit] = useState(0);
      const props = {
        read: read as FactsCurrent,
        property,
        locale: 'en',
        search,
        transport,
        review: (field: string, session?: string) => fixture.props.review(characterProfileId, field, session),
      };
      return (
        <CatalogueCurrentReading visible={ready} ready={ready} revision={ready ? 'fresh' : 'failed'}>
          <AuthoringDepartureBoundary sessionBound={false}>
            <DepartureButton proceed={() => setVisit((current) => current + 1)} />
            <output data-visit>{visit}</output>
            <div key={visit}>
              <CharacterClassification {...props} />
              <CharacterClassification {...props} />
            </div>
          </AuthoringDepartureBoundary>
        </CatalogueCurrentReading>
      );
    }
    const renderWorkspace = (ready = true) => render(<Workspace ready={ready} />);
    const settle = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !ready(); attempt++)
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 10)));
      expect(ready()).toBe(true);
    };
    const sections = () =>
      [...host.querySelectorAll<HTMLElement>('section')].filter((section) => section.querySelector('h3'));
    const choose = async (section: HTMLElement, value: string) =>
      act(async () => {
        const select = section.querySelector<HTMLSelectElement>('select')!;
        select.value = value;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    const pick = async (section: HTMLElement, title: string) => {
      const input = section.querySelector<HTMLInputElement>('[role="combobox"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'concept');
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await settle(() => [...host.ownerDocument.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes(title)));
      await act(async () => {
        [...host.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((option) => option.textContent?.includes(title))!
          .click();
      });
    };
    const beforeUnload = () => {
      const event = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const prompt = () => host.ownerDocument.querySelector<HTMLElement>('[role="alertdialog"]');
    await renderWorkspace();
    const [first, second] = sections();
    await choose(first!, read.public.subject.statements[property]![0]?.id ?? '');
    await act(async () => button(first!, m.facts_edit_field()).click());
    await act(async () => button(second!, m.facts_add_value()).click());
    expect(beforeUnload()).toBe(false);
    await pick(first!, 'Replacement concept');
    await pick(second!, 'Original concept');
    expect(beforeUnload()).toBe(true);
    await act(async () => button(host, 'Open candidate review').click());
    expect(host.ownerDocument.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(host.ownerDocument.getElementById(prompt()!.getAttribute('aria-describedby')!)!.textContent).toBe(
      m.thread_authoring_leave_unsaved(),
    );
    await act(async () => button(prompt()!, m.thread_authoring_stay()).click());
    expect(sections().map((section) => section.querySelector<HTMLInputElement>('[role="combobox"]')!.value)).toEqual([
      'Replacement concept',
      'Original concept',
    ]);
    await act(async () => button(first!, m.correction_submit()).click());
    expect(commands).toHaveLength(1);
    const sources = read.public.subject.statements[property]!;
    const expected = statementInput(sources[0]!);
    expected.value = { type: 'value', content: replacement };
    expect(commands[0]!.statement).toEqual(expected);
    expect(beforeUnload()).toBe(true);
    await act(async () => button(host, 'Open candidate review').click());
    expect(host.ownerDocument.getElementById(prompt()!.getAttribute('aria-describedby')!)!.textContent).toBe(
      m.thread_authoring_leave_pending(),
    );
    await act(async () => button(prompt()!, m.thread_authoring_stay()).click());
    await renderWorkspace(false);
    expect(beforeUnload()).toBe(true);
    await act(async () => button(host, 'Open candidate review').click());
    expect(prompt()).not.toBeNull();
    await act(async () => button(prompt()!, m.thread_authoring_stay()).click());
    await renderWorkspace(true);
    expect(sections()[0]!.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toBe('Replacement concept');
    expect(button(sections()[0]!, m.correction_retry()).disabled).toBe(false);
    await act(async () => button(sections()[0]!, m.correction_retry()).click());
    await settle(() => firstResult !== undefined);
    expect(commands[1]).toBe(commands[0]);
    await act(async () => button(host, 'Open candidate review').click());
    expect(host.ownerDocument.getElementById(prompt()!.getAttribute('aria-describedby')!)!.textContent).toBe(
      m.thread_authoring_leave_unsaved(),
    );
    await act(async () => button(prompt()!, m.thread_authoring_leave()).click());
    await settle(() => host.querySelector('[data-visit]')?.textContent === '1');
    expect(beforeUnload()).toBe(false);
    await act(async () => finishFirst(firstResult!));
    expect(host.textContent).not.toContain(m.correction_proposed());
    const fresh = sections()[0]!;
    await choose(fresh, read.public.subject.statements[property]![0]!.id);
    await act(async () => button(fresh, m.facts_edit_field()).click());
    await pick(fresh, 'Replacement concept');
    await act(async () => button(fresh, m.correction_submit()).click());
    await settle(() => sections()[0]?.textContent?.includes(m.correction_proposed()) === true);
    expect(beforeUnload()).toBe(false);
    await act(async () => button(host, 'Open candidate review').click());
    await settle(() => host.querySelector('[data-visit]')?.textContent === '2');
    expect(prompt()).toBeNull();
  });
});
