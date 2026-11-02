import { createRequire } from 'node:module';
import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { ConditionEditor } from '../src/search/condition-editor';
import { CONDITION_POINTER, conditionMetadata } from '../src/search/condition-editor-model';
import { m } from '../src/paraglide/messages.js';

test('range drafts follow surviving occurrences, retire on removal, and reset on replacement', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/search' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: Root | undefined;
  try {
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('form');
    window.document.body.append(host);
    root = createRoot(host as unknown as HTMLElement);
    const metadata = conditionMetadata(recording.release);
    metadata.properties['compatible'] = { ...metadata.properties['schema:wordCount']! };
    metadata.types = { test: { bases: [], facets: ['schema:wordCount', 'compatible', 'schema:datePublished'] } };
    const range = (): FilterDocument => ({
      statement: { property: 'schema:wordCount', range: { gte: 12, lte: 20, unit: '1' } },
    });
    const shared = range();
    const initial: FilterDocument = { and: [shared, shared, shared] };
    let committed: FilterDocument | undefined = initial;
    const replace = (value: FilterDocument | undefined) => {
      committed = value;
      root!.render(
        createElement(ConditionEditor, {
          value: committed,
          metadata,
          locale: 'en',
          onChange: replace,
        }),
      );
    };
    await act(async () => replace(initial));
    const node = (path: string) => host.querySelector(`[data-condition-pointer="${CONDITION_POINTER}${path}"]`)!;
    const input = (path: string, bound = 'gte') =>
      host.querySelector<HTMLInputElement>(
        `[data-condition-field-pointer="${CONDITION_POINTER}${path}/statement/range/${bound}"] input`,
      )!;
    const change = async (element: HTMLInputElement | HTMLSelectElement, value: string) =>
      act(async () => {
        const prototype =
          element.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLSelectElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new window.Event(element.tagName === 'INPUT' ? 'input' : 'change', { bubbles: true }));
      });
    const operator = (path: string, value: string) => change(node(path).querySelector('select')!, value);
    const property = (path: string, value: string) =>
      change(
        node(path).querySelector<HTMLSelectElement>('[data-condition-field-pointer$="/statement/property"] select')!,
        value,
      );
    const remove = async (path: string) =>
      act(async () => {
        Array.from(node(path).querySelectorAll('button'))
          .find((button) => button.textContent === m.condition_remove())!
          .click();
      });
    const assertDraft = (path: string, raw: string, invalid = true, bound = 'gte') => {
      expect(input(path, bound).value).toBe(raw);
      expect(input(path, bound).validity.customError).toBe(invalid);
    };
    await change(input('/and/1'), '1e+');
    await change(input('/and/2'), '-');
    expect(committed).toBe(initial);
    expect(host.checkValidity()).toBe(false);
    await remove('/and/0');
    assertDraft('/and/0', '1e+');
    assertDraft('/and/1', '-');
    await remove('/and/0');
    assertDraft('/and/0', '-');
    await operator('/and/0', 'not');
    assertDraft('/and/0/not', '-');
    await operator('/and/0', 'and'); // Wrap NOT, preserving its operand.
    assertDraft('/and/0/and/0/not', '-');
    await operator('/and/0', 'or');
    assertDraft('/and/0/or/0/not', '-');
    await operator('/and/0/or/0', '');
    assertDraft('/and/0/or/0', '-');
    await property('/and/0/or/0', 'compatible');
    assertDraft('/and/0/or/0', '-');
    // A sibling field edit must not remount the unfinished lower bound.
    await change(input('/and/0/or/0', 'lte'), '25');
    assertDraft('/and/0/or/0', '-');
    expect(JSON.stringify(committed)).toContain('"lte":25');
    await change(input('/and/0/or/0'), '15');
    expect(host.checkValidity()).toBe(true);
    await change(input('/and/0/or/0'), '1e309');
    await property('/and/0/or/0', 'schema:datePublished');
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === m.condition_property_change_confirm())!
        .click(),
    );
    assertDraft('/and/0/or/0', '', false);
    await act(async () => replace(initial)); // Reuse the original document, not just a fresh clone.
    assertDraft('/and/0', '12', false);
    expect(host.checkValidity()).toBe(true);
    await change(input('/and/0'), '-');
    await remove('/and/0');
    assertDraft('/and/0', '12', false);
    expect(host.checkValidity()).toBe(true);
    await act(async () =>
      Array.from(node('').querySelectorAll('button'))
        .find((button) => button.textContent === m.condition_add_statement())!
        .click(),
    );
    await property('/and/2', 'schema:wordCount');
    assertDraft('/and/2', '', false);
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
