import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import type { FactCommand, FactResult, FactsCurrent } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('classification admits only current draft callbacks before private values or descriptors change', async () => {
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
      value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(window, name),
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { CatalogueCurrentReading, catalogueEditor } = await import('../src/features/catalogue/editor-lifetime');
  const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
  const { characterProfileFixture, characterProfileId } =
    await import('../src/kernel/fake/catalogue-character-profile');
  const { statementInput } = await import('../src/features/catalogue/statement-editor');
  const { m } = await import('../src/paraglide/messages.js');
  setLocale('en', { reload: false });
  const fixture = characterProfileFixture('uncertain');
  const read: FactsCurrent = {
    ok: true,
    public: fixture.character,
    release: structuredClone(fixture.release),
    source: null,
  };
  const property = 'schema:keywords';
  const concept = '00000000-0000-4000-8000-00000000d101';
  const replacement = '00000000-0000-4000-8000-00000000d102';
  const source = structuredClone(read.public.subject.statements['schema:height']![0]!);
  source.property = { id: property, data_type: 'wikibase-item' };
  source.value = { type: 'value', content: concept };
  source.references = [
    {
      hash: 'current-draft',
      parts: [
        {
          property: { id: 'schema:url', data_type: 'url' },
          value: { type: 'value', content: 'https://example.test/original' },
        },
      ],
    },
  ];
  read.public.subject.statements[property] = [source];
  const original = statementInput(source);
  const sent: FactCommand[] = [];
  let delivery = Promise.withResolvers<FactResult>();
  const props = {
    property,
    read,
    locale: 'en',
    search: async () => [],
    transport: {
      ...fixture.props.facts(characterProfileId),
      propose: (command: FactCommand) => {
        sent.push(command);
        return delivery.promise;
      },
    },
    review: (field: string, session?: string) => fixture.props.review(characterProfileId, field, session),
  };
  const Editor = catalogueEditor(CharacterClassification);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const render = (revision = 'current') =>
    act(async () =>
      root.render(h(CatalogueCurrentReading, { visible: true, ready: true, revision }, h(Editor, props))),
    );
  const click = (label: string) =>
    act(async () => {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
      expect(button).toBeDefined();
      button!.click();
    });
  const input = () => host.querySelector<HTMLInputElement>('input[type="url"]')!;
  const nested = () => {
    const node = input();
    const key = Object.keys(node).find((name) => name.startsWith('__reactProps'))!;
    const callback = Reflect.get(node, key).onChange;
    return (value: string) => callback({ target: { value } });
  };
  const picker = (): ((items: EntityPickerSubject[]) => void) => {
    const node = host.querySelector('[role="combobox"]')!;
    const key = Object.keys(node).find((name) => name.startsWith('__reactFiber'))!;
    let root = Reflect.get(node, key);
    while (root.return) root = root.return;
    const pending = [root.stateNode.current];
    while (pending.length) {
      const fiber = pending.pop();
      const props = fiber.memoizedProps;
      if (typeof props?.search === 'function' && typeof props?.onValueChange === 'function') return props.onValueChange;
      if (fiber.child) pending.push(fiber.child);
      if (fiber.sibling) pending.push(fiber.sibling);
    }
    throw new Error('Missing mounted EntityPicker callback');
  };
  const item = (id: string, title: string): EntityPickerSubject[] => [
    { id, title, types: ['skos:Concept'], typeLabel: '', cover: null },
  ];
  const display = () => host.querySelector<HTMLInputElement>('[role="combobox"]')!.value;
  const edit = (callback: () => void) => act(async () => callback());
  try {
    await render();
    await click(m.facts_edit_field());
    const discardedPicker = picker();
    const discardedNested = nested();
    await edit(() => nested()('https://example.test/discarded'));
    await click(m.curation_view_discard());
    await click(m.curation_view_discard());
    await edit(() => {
      discardedPicker(item(replacement, 'Discarded'));
      discardedNested('https://example.test/retired');
    });
    expect(host.querySelector('fieldset')).toBeNull();
    await click(m.facts_edit_field());
    await edit(() => picker()(item(replacement, 'Current selection')));
    await edit(() => {
      discardedPicker(item(replacement, 'Wrong descriptor'));
      discardedNested('https://example.test/wrong-holder');
    });
    expect(display()).toBe('Current selection');
    expect(input().value).toBe('https://example.test/original');
    const beforeSiblingPicker = picker();
    const beforeSiblingNested = nested();
    await edit(() => {
      nested()('https://example.test/current');
      beforeSiblingNested('https://example.test/batched-stale');
    });
    await edit(() => {
      beforeSiblingPicker(item(concept, 'Stale edit'));
      beforeSiblingNested('https://example.test/stale');
    });
    expect(input().value).toBe('https://example.test/current');
    expect(display()).toBe('Current selection');
    const lockedPicker = picker();
    const lockedNested = nested();
    await click(m.correction_submit());
    await edit(() => {
      lockedPicker(item(concept, 'Locked'));
      lockedNested('https://example.test/locked');
    });
    expect(display()).toBe('Current selection');
    expect(input().value).toBe('https://example.test/current');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe(characterProfileId);
    expect(sent[0]!.statement).toEqual({
      ...original,
      value: { type: 'value', content: replacement },
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/current' } },
          ],
        },
      ],
    });
    await edit(() => delivery.resolve({ ok: false, reason: 'uncertain' }));
    await edit(() => {
      lockedPicker(item(replacement, 'Uncertain'));
      lockedNested('https://example.test/uncertain');
    });
    expect(display()).toBe('Current selection');
    delivery = Promise.withResolvers<FactResult>();
    await click(m.correction_retry());
    expect(sent[1]).toBe(sent[0]);
    await render('replacement-reading');
    await edit(() =>
      delivery.resolve({ ok: true, kind: 'proposed-awaiting-review', candidate: 'late-result', revision: 1 }),
    );
    expect(host.textContent).not.toContain(m.correction_proposed());
    expect(input().value).toBe('https://example.test/current');
    expect(statementInput(source)).toEqual(original);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
