import { dirname } from 'node:path';
import { expect, test } from 'bun:test';
import { act, createElement, useState, type Dispatch, type SetStateAction } from 'react';
import type { Root } from 'react-dom/client';
import type { FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { CONDITION_POINTER, conditionMetadata } from '../src/search/condition-editor-model';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

test('queued condition-edit focus cannot steal focus after a user move or target a replacement document at the same pointer', async () => {
  const window = new Window({ url: 'https://site.test/en/search' });
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { ConditionEditor } = await import('../src/search/condition-editor');
  const host = window.document.createElement('form');
  const outside = window.document.createElement('button');
  outside.textContent = 'Outside';
  window.document.body.append(host, outside);
  const metadata = conditionMetadata(recording.release);
  const initial: FilterDocument = { and: [{ type: { in: ['schema:Book'] } }] };
  const replacement: FilterDocument = {
    and: [{ type: { in: ['schema:Movie'] } }, { statement: { property: '', in: [''] } }],
  };
  let setValue!: Dispatch<SetStateAction<FilterDocument | undefined>>;
  let setDisabled!: Dispatch<SetStateAction<boolean>>;
  function Harness({ starting }: { starting: FilterDocument | undefined }) {
    const [value, updateValue] = useState(starting);
    const [disabled, updateDisabled] = useState(false);
    setValue = updateValue;
    setDisabled = updateDisabled;
    return createElement(ConditionEditor, {
      value,
      metadata,
      locale: 'en',
      disabled,
      onChange: updateValue,
    });
  }
  let root: Root | undefined;
  const flush = () =>
    act(async () => {
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback(0);
    });
  const node = (path: string) =>
    host.querySelector<HTMLElement>(`[data-condition-pointer="${CONDITION_POINTER}${path}"]`)!;
  const control = (path: string) =>
    node(path).querySelector<HTMLElement>(
      'select:not(:disabled), input:not([type="hidden"]):not(:disabled), button:not(:disabled)',
    )!;
  const action = (label: string) => [...host.querySelectorAll('button')].find((button) => button.textContent === label)!;
  const live = () => host.querySelector('[aria-live="polite"]')?.textContent;
  try {
    root = createRoot(host as unknown as HTMLElement);
    await act(async () => root!.render(createElement(Harness, { starting: initial })));
    await flush();

    await act(async () => action(m.condition_add_type()).click());
    expect(live()).toBe(m.condition_added());
    expect(node('/and/1')).toBeTruthy();
    expect(window.document.activeElement).toBe(action(m.condition_add_type()));
    await flush();
    expect(window.document.activeElement).toBe(control('/and/1'));

    await act(async () => action(m.condition_add_type()).click());
    await act(async () => action(m.condition_add_statement()).click());
    expect(live()).toBe(m.condition_added());
    await flush();
    expect(window.document.activeElement).toBe(control('/and/3'));

    await act(async () => setValue(initial));
    await flush();
    await act(async () => action(m.condition_add_type()).click());
    await act(async () => outside.focus());
    await flush();
    expect(window.document.activeElement).toBe(outside);
    expect(live()).toBe(m.condition_added());

    await act(async () => setValue(initial));
    await flush();
    await act(async () => action(m.condition_add_type()).click());
    const scheduledKey = node('/and/1').dataset.conditionNode;
    await act(async () => setValue(replacement));
    await flush();
    expect(node('/and/1').dataset.conditionNode).not.toBe(scheduledKey);
    expect(window.document.activeElement).not.toBe(node('/and/1').querySelector('select'));

    await act(async () => setValue(initial));
    await flush();
    await act(async () => action(m.condition_add_type()).click());
    await act(async () => setDisabled(true));
    await flush();
    expect(window.document.activeElement).not.toBe(node('/and/1').querySelector('select'));

    await act(async () => setDisabled(false));
    await act(async () => setValue(initial));
    await flush();
    await act(async () => action(m.condition_add_type()).click());
    await act(async () => root!.unmount());
    root = undefined;
    await flush();
    expect(frames.size).toBe(0);
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
