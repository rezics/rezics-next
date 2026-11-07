import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import collection from '../src/kernel/recorded/library-collection.json';
import type { FilteredAddOperation } from '../src/library/bulk-filtered-add-native';
import { captureFilteredAdd } from '../src/library/bulk-filtered-add';

const destination = collection.collection;
let authority = true;
let preparing = true;
let confirmations = 0;
mock.module('../src/library/collection-owner-current', () => ({
  useCollectionOwnerCurrent: () => ({
    subject: destination.curatorAccountId,
    admitted: true,
    lifetime: 'origin',
    isOwnerCurrent: () => authority,
    isCurrent: () => authority,
    operationCurrent: () => authority,
    credential: () => 'csrf',
  }),
}));
mock.module('../src/library/collection-move-chooser', () => ({
  CollectionMoveChooser: ({ onChange }: { onChange: (choice: { destination: typeof destination }) => void }) => (
    <button type="button" onClick={() => onChange({ destination })}>
      Choose destination
    </button>
  ),
}));
mock.module('../src/library/bulk-filtered-add-server', () => ({
  filteredAddPort: {
    capture: async (capture: unknown) => ({ state: 'captured', command: { capture } }),
    preview: async () => (preparing ? { state: 'preparing' } : { state: 'ready', operation: native }),
    confirm: async () => {
      confirmations++;
      return { state: 'ready', operation: { ...native, phase: 'queued' } };
    },
  },
  filteredAddReader: () => async () => ({ state: 'unavailable' }),
}));
const source = { id: destination.id };
const captured = captureFilteredAdd(source, destination);
if (!captured.ok) throw new Error('Expected admitted input');
const native = {
  id: destination.id,
  action: 'add_to_collection',
  selectionKind: 'query',
  collectionId: destination.id,
  selectionSource: { id: source.id, filter: null, sort: null, sourceDigest: 'a'.repeat(64), selectedSubjects: 42 },
  phase: 'preview',
  selectionComplete: true,
  occurrencesComplete: true,
  counts: {
    targets: 42,
    selectedSubjects: 42,
    applied: 0,
    no_effect: 0,
    conflict: 0,
    denied: 0,
    failed: 0,
    cancelled: 0,
    pending: 42,
    reconciling: 0,
  },
  expiresAt: '2099-11-05T00:00:00Z',
  reason: null,
} as FilteredAddOperation;
const { Window } = await import('happy-dom');
const window = new Window({ url: 'https://site.test/en/collections/source' });
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
const { BulkFilteredAdd } = await import('../src/library/bulk-filtered-add-view');
const { m } = await import('../src/paraglide/messages.js');
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const settle = (action: () => void) =>
  act(async () => {
    action();
    await Bun.sleep(10);
  });

test('explicit destination and exact whole-population preview precede confirmation; preparing is not ready', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await settle(() => root.render(<BulkFilteredAdd source={source} address="source" />));
  const button = (text: string) => [...host.querySelectorAll('button')].find((value) => value.textContent === text);
  expect(button(m.library_filtered_add_preview())?.disabled).toBe(true);
  await settle(() => button('Choose destination')!.click());
  await settle(() => button(m.library_filtered_add_preview())!.click());
  expect(host.textContent).toContain(m.library_filtered_add_preparing());
  expect(button(m.library_filtered_add_confirm())).toBeUndefined();
  preparing = false;
  await settle(() => button(m.library_filtered_add_retry())!.click());
  expect(host.textContent).toContain(
    m.library_filtered_add_destination({ title: destination.title, id: destination.id }),
  );
  expect(host.textContent).toContain(m.library_filtered_add_count({ count: 42 }));
  expect(confirmations).toBe(0);
  await settle(() => button(m.library_filtered_add_confirm())!.click());
  expect(confirmations).toBe(1);
  expect(host.querySelector('a')?.getAttribute('href')).toBe(`/en/library/operations/${native.id}`);
  await settle(() => root.unmount());
  host.remove();
});
