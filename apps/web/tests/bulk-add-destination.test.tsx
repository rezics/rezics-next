import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import collection from '../src/kernel/recorded/library-collection.json';
import members from '../src/kernel/recorded/library-collection-members.json';
import { captureBulkAddSelection, type BulkAddCapture } from '../src/library/bulk-add-selection';

const original = { ...collection.collection };
let placementReads = 0;
mock.module('../src/library/collection-read', () => ({ readCollectionDestination: async () => original }));
mock.module('../src/library/collection-move-read', () => ({
  readCollectionMoveChoices: async ({ data }: { data?: string }) => ({
    collections: [{ id: original.id, title: data ? 'Refreshed destination' : original.title }],
    next: data ? null : 'next',
  }),
  readCollectionMovePlacements: async () => {
    placementReads++;
    throw new Error('Unexpected membership read');
  },
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library' });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'getComputedStyle',
  'IS_REACT_ACT_ENVIRONMENT',
]) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[name as keyof typeof window],
  });
}
const { createRoot } = await import('react-dom/client');
const { BulkAddDestination } = await import('../src/library/bulk-add-destination');
const { m } = await import('../src/paraglide/messages.js');
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const settle = (action = () => {}) =>
  act(async () => {
    action();
    await Bun.sleep(10);
  });

test('requires an explicit private destination, preserves it across choice refresh, and captures once without membership effects', async () => {
  const selection = captureBulkAddSelection(members.members);
  if (!selection.ok) throw new Error('Missing loaded selection');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const captures: BulkAddCapture[] = [];
  await settle(() =>
    root.render(
      <BulkAddDestination selection={selection} current={() => true} onCapture={(value) => captures.push(value)} />,
    ),
  );
  const submit = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(submit().disabled).toBe(true);
  expect(captures).toEqual([]);
  await settle(() => host.querySelector<HTMLButtonElement>(`[data-move-destination="${original.id}"]`)!.click());
  expect(submit().disabled).toBe(false);
  expect(placementReads).toBe(0);
  await settle(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === m.library_collection_move_more_destinations())!
      .click(),
  );
  expect(host.querySelectorAll('[data-move-destination]')).toHaveLength(1);
  await settle(() => submit().click());
  expect(captures).toEqual([
    {
      subjects: selection.subjects,
      destination: { id: original.id, title: original.title, revision: original.revision },
    },
  ]);
  expect(submit().disabled).toBe(true);
  await settle(() =>
    host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(captures).toHaveLength(1);
  expect(placementReads).toBe(0);
  const replacement = { ...selection, subjects: [...selection.subjects, 'later-subject'] };
  await settle(() =>
    root.render(
      <BulkAddDestination selection={replacement} current={() => true} onCapture={(value) => captures.push(value)} />,
    ),
  );
  expect(host.textContent).toContain(m.library_bulk_add_captured_destination({ title: original.title }));
  await settle(() => root.unmount());
  host.remove();
});

test('producer selection change retires an unsubmitted bulk destination and requires a new choice', async () => {
  const selection = captureBulkAddSelection(members.members);
  if (!selection.ok) throw new Error('Missing loaded selection');
  const replacement = { ...selection, subjects: [...selection.subjects, 'later-subject'] };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const captures: BulkAddCapture[] = [];
  const render = (value: typeof selection) =>
    root.render(
      <BulkAddDestination selection={value} current={() => true} onCapture={(capture) => captures.push(capture)} />,
    );
  await settle(() => render(selection));
  await settle(() => host.querySelector<HTMLButtonElement>(`[data-move-destination="${original.id}"]`)!.click());
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  await settle(() => render(replacement));
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(captures).toEqual([]);
  await settle(() => host.querySelector<HTMLButtonElement>(`[data-move-destination="${original.id}"]`)!.click());
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  await settle(() => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(captures[0]?.subjects).toEqual(replacement.subjects);
  await settle(() => root.unmount());
  host.remove();
});
