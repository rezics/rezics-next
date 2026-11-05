import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import type { FactCommand, FactResult, FactsCurrent } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('Character classification confirms only its edited draft and preserves it across cancel and lifetime changes', async () => {
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
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
  const { CharacterClassification } = await import('../src/features/catalogue/character-profile-classification');
  const { characterProfileFixture, characterProfileId } =
    await import('../src/kernel/fake/catalogue-character-profile');
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
  const source = structuredClone(read.public.subject.statements['schema:height']![0]!);
  source.id = '00000000-0000-4000-8000-000000000801';
  source.property = { id: property, data_type: 'wikibase-item' };
  source.value = { type: 'value', content: '00000000-0000-4000-8000-00000000d101' };
  source.qualifiers = [
    {
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+0', unit: '1' } },
    },
  ];
  source.references = [
    {
      hash: 'discard-test',
      parts: [
        {
          property: { id: 'schema:url', data_type: 'url' },
          value: { type: 'value', content: 'https://archive.example/source' },
        },
      ],
    },
  ];
  read.public.subject.statements[property] = [source];
  read.release.properties[property]!.targets = ['skos:Concept'];
  read.public.related[source.value.type === 'value' ? (source.value.content as string) : ''] = {
    type: 'skos:Concept',
    labels: { en: 'Original concept' },
  };
  read.public.related['00000000-0000-4000-8000-00000000d102'] = {
    type: 'skos:Concept',
    labels: { en: 'Public replacement label' },
  };
  const sent: FactCommand[] = [];
  const delivery = Promise.withResolvers<FactResult>();
  const native = fixture.props.facts(characterProfileId);
  const transport = {
    ...native,
    propose: (command: FactCommand) => {
      sent.push(command);
      return delivery.promise;
    },
  };
  const replacement = '00000000-0000-4000-8000-00000000d102';
  const props = {
    property,
    read,
    locale: 'en',
    search: async () => [
      { id: replacement, title: 'Selected search summary', types: ['skos:Concept'], typeLabel: '', cover: null },
    ],
    transport,
    review: (field: string, session?: string) => fixture.props.review(characterProfileId, field, session),
  };
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const render = (ready = true) =>
    act(async () =>
      root.render(
        h(
          CatalogueCurrentReading,
          { visible: true, ready, revision: ready ? 'current' : 'unavailable' },
          h(
            'div',
            null,
            h(CharacterClassification, { ...props, key: 'first' }),
            h(CharacterClassification, { ...props, key: 'second' }),
          ),
        ),
      ),
    );
  const sections = () => [...host.querySelectorAll<HTMLElement>('section')];
  const button = (region: Element, name: string) => {
    const found = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
    expect(found).toBeDefined();
    return found!;
  };
  const click = (node: HTMLElement) => act(async () => node.click());
  const enter = (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const chooseReplacement = async (region: HTMLElement) => {
    const picker = region.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await enter(picker, 'Replacement');
    for (let attempt = 0; attempt < 100 && !host.querySelector('[role="option"]'); attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await click(host.querySelector<HTMLElement>('[role="option"]')!);
    return picker;
  };
  const clickProps = (node: HTMLElement) => {
    const key = Object.keys(node).find((name) => name.startsWith('__reactProps'));
    if (!key) throw new Error('Missing React click props');
    return (node as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
  };
  try {
    await render();
    const [first, second] = sections();
    await click(button(first!, m.facts_edit_field()));
    const firstUrl = first!.querySelector<HTMLInputElement>('input[type="url"]')!;
    await enter(firstUrl, 'https://archive.example/source-edited');
    const picker = await chooseReplacement(first!);
    expect(picker.value).toBe('Selected search summary');
    const fields = [...first!.querySelectorAll<HTMLInputElement>('input')];
    const addresses = fields.map(({ id }) => id);
    const values = fields.map(({ value }) => value);
    expect(fields).toContain(firstUrl);
    await click(button(first!, m.curation_view_discard()));
    const cancel = button(first!, m.candidate_cancel());
    expect(window.document.activeElement).toBe(cancel);
    expect([...first!.querySelectorAll('input')]).toEqual(fields);
    expect(fields.map(({ id, value }) => [id, value])).toEqual(
      fields.map((field, index) => [addresses[index], values[index]]),
    );
    expect(picker.value).toBe('Selected search summary');
    await act(async () =>
      first!
        .querySelector('[role="group"]')!
        .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(window.document.activeElement).toBe(button(first!, m.curation_view_discard()));
    expect(first!.querySelector('fieldset')).not.toBeNull();
    expect(sent).toEqual([]);

    await click(button(first!, m.curation_view_discard()));
    const staleConfirm = button(first!, m.curation_view_discard());
    const staleClick = clickProps(staleConfirm);
    await render(false);
    await act(async () => staleClick());
    expect(first!.querySelector('fieldset')).not.toBeNull();
    expect(firstUrl.value).toBe('https://archive.example/source-edited');
    expect(sent).toEqual([]);
    await render();
    expect(first!.querySelector('fieldset')).not.toBeNull();
    expect(first!.querySelectorAll('button').length).toBeGreaterThan(0);
    await click(button(first!, m.curation_view_discard()));
    expect(first!.querySelector('[role="group"]')).not.toBeNull();
    await click(button(first!, m.curation_view_discard()));
    expect(first!.querySelector('fieldset')).toBeNull();
    expect(window.document.activeElement).toBe(first!.querySelector('select'));
    expect(second!.querySelector('fieldset')).not.toBeNull();
    expect(sent).toEqual([]);

    await click(button(first!, m.facts_edit_field()));
    await click(button(first!, m.curation_view_discard()));
    expect(first!.querySelector('fieldset')).toBeNull();
    expect(first!.querySelector('[role="group"]')).toBeNull();

    await click(button(second!, m.facts_add_value()));
    await click(button(second!, m.curation_view_discard()));
    expect(second!.querySelector('fieldset')).toBeNull();
    expect(second!.querySelector('[role="group"]')).toBeNull();
    expect(sent).toEqual([]);

    await click(button(second!, m.facts_add_value()));
    const secondPicker = await chooseReplacement(second!);
    expect(secondPicker.value).toBe('Selected search summary');
    await click(button(second!, m.curation_view_discard()));
    const pendingConfirm = button(second!, m.curation_view_discard());
    const confirmWhileBusy = clickProps(pendingConfirm);
    await act(async () => {
      button(second!, m.correction_submit()).click();
      confirmWhileBusy();
    });
    expect(second!.querySelector('fieldset')!.disabled).toBe(true);
    expect(sent).toHaveLength(1);
    await act(async () => delivery.resolve({ ok: false, reason: 'uncertain' }));
    expect(second!.querySelector('fieldset')!.disabled).toBe(true);
    expect(button(second!, m.curation_view_discard()).disabled).toBe(true);
    expect(sent).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
