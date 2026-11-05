import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import * as start from '../.storybook/react-start';
import type { MoveChoices, MovePlacements } from '../src/library/collection-move-read';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
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
const reads = await import('../src/library/collection-move-read');
const destinationReads = await import('../src/library/collection-read');
const { CollectionMoveChooser } = await import('../src/library/collection-move-chooser');
import type { CollectionMoveChoice } from '../src/library/collection-move-chooser';
const { m } = await import('../src/paraglide/messages.js');

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
function deferred<T>() {
  return Promise.withResolvers<T>();
}
const settle = (work: () => void = () => {}) =>
  act(async () => {
    work();
  });
const catalogue = (next: string | null = null): MoveChoices => ({
  collections: [
    { id: 'target', title: 'Target' },
    { id: 'other', title: 'Other' },
  ],
  next,
});
const anchors = (next: string | null = null): MovePlacements => ({
  members: [
    { id: 'occurrence-a', title: 'Repeated subject' },
    { id: 'occurrence-b', title: 'Repeated subject' },
  ],
  next,
});
function mounted() {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let choice: CollectionMoveChoice | null = null;
  let current = true;
  const render = (key = 'first') =>
    root.render(
      createElement(CollectionMoveChooser, {
        key,
        sourceId: 'source',
        disabled: false,
        current: () => current,
        onChange: (value) => {
          choice = value;
        },
      }),
    );
  const click = (label: string) =>
    settle(() => {
      const button = [...host.querySelectorAll('button')].find((row) => row.textContent === label);
      expect(button).toBeDefined();
      button!.click();
    });
  const row = (id: string) => host.querySelector<HTMLButtonElement>(`[data-move-destination="${id}"]`)!;
  return {
    host,
    render,
    click,
    row,
    choice: () => choice,
    retire: () => {
      current = false;
    },
    close: async () => {
      await settle(() => root.unmount());
      host.remove();
    },
  };
}

test('bounded recovery repeats failed Next/Previous, refuses stale choices and explicitly restarts expiry', async () => {
  let pending = deferred<MoveChoices>();
  const choiceRead = spyOn(reads, 'readCollectionMoveChoices').mockImplementation(() => pending.promise);
  const header = spyOn(destinationReads, 'readCollectionDestination').mockResolvedValue({
    id: 'target',
    title: 'Target',
    revision: 7,
  });
  const pageRead = spyOn(reads, 'readCollectionMovePlacements').mockResolvedValue(anchors('p2'));
  const view = mounted();
  try {
    await settle(() => view.render());
    await settle(() => pending.resolve(catalogue('c2')));
    pending = deferred();
    await view.click(m.library_collection_move_more_destinations());
    expect(choiceRead.mock.calls.at(-1)![0]).toEqual({ data: 'c2' });
    await settle(() => pending.reject(new Error('offline')));
    expect(view.row('target').disabled).toBe(true);
    // A synthetic event must also be refused by the handler.
    await settle(() => {
      view.row('target').disabled = false;
      view.row('target').click();
    });
    expect(header).not.toHaveBeenCalled();
    pending = deferred();
    await view.click(m.library_collection_move_retry());
    expect(choiceRead.mock.calls.at(-1)![0]).toEqual({ data: 'c2' });
    await settle(() => pending.resolve(catalogue('c3')));
    pending = deferred();
    await view.click(m.library_collection_move_more_destinations());
    await settle(() => pending.resolve(catalogue()));
    pending = deferred();
    await view.click(m.library_collection_move_previous());
    await settle(() => pending.reject(new Error('offline')));
    pending = deferred();
    await view.click(m.library_collection_move_retry());
    expect(choiceRead.mock.calls.at(-1)![0]).toEqual({ data: 'c2' });
    await settle(() => pending.resolve(catalogue('c3')));
    expect(
      [...view.host.querySelectorAll('button')].some((b) => b.textContent === m.library_collection_move_previous()),
    ).toBe(false);
    pending = deferred();
    await view.click(m.library_collection_move_more_destinations());
    await settle(() => pending.reject(new Error('stale_cursor')));
    pending = deferred();
    await view.click(m.library_collection_move_restart());
    expect(choiceRead.mock.calls.at(-1)![0]).toEqual({ data: undefined });
    await settle(() => pending.resolve(catalogue()));
    await settle(() => view.row('target').click());
    let placement = deferred<MovePlacements>();
    pageRead.mockImplementation(() => placement.promise);
    await view.click(m.library_collection_move_more_members());
    await settle(() => placement.reject(new Error('offline')));
    placement = deferred();
    await view.click(m.library_collection_move_retry());
    expect(pageRead.mock.calls.at(-1)![0]).toEqual({ data: { collectionId: 'target', revision: 7, cursor: 'p2' } });
    await settle(() => placement.resolve(anchors('p3')));
    placement = deferred();
    await view.click(m.library_collection_move_more_members());
    await settle(() => placement.resolve(anchors()));
    placement = deferred();
    await view.click(m.library_collection_move_previous());
    await settle(() => placement.reject(new Error('offline')));
    placement = deferred();
    await view.click(m.library_collection_move_retry());
    expect(pageRead.mock.calls.at(-1)![0].data.cursor).toBe('p2');
    await settle(() => placement.resolve(anchors('p3')));
    const browse = view.host.querySelector('[data-placement-browse]')!;
    expect(
      [...browse.querySelectorAll('button')].some((b) => b.textContent === m.library_collection_move_previous()),
    ).toBe(false);
    placement = deferred();
    await view.click(m.library_collection_move_more_members());
    await settle(() => placement.reject(new Error('stale_cursor')));
    placement = deferred();
    await view.click(m.library_collection_move_restart());
    expect(pageRead.mock.calls.at(-1)![0].data.cursor).toBeUndefined();
    await settle(() => placement.resolve(anchors()));
    expect(view.choice()).toBeNull();
  } finally {
    await view.close();
  }
});

test('recovery keeps exact revision/occurrence, requires re-selection and retires replaced or detached responses', async () => {
  spyOn(reads, 'readCollectionMoveChoices').mockResolvedValue(catalogue());
  const header = spyOn(destinationReads, 'readCollectionDestination').mockResolvedValue({
    id: 'target',
    title: 'Target',
    revision: 7,
  });
  let pending = deferred<MovePlacements>();
  const pageRead = spyOn(reads, 'readCollectionMovePlacements').mockImplementation(() => pending.promise);
  const view = mounted();
  try {
    await settle(() => view.render());
    header.mockRejectedValueOnce(new Error('offline'));
    await settle(() => view.row('target').click());
    await view.click(m.library_collection_move_reread_destination());
    expect(header.mock.calls.at(-1)![0]).toEqual({ data: 'target' });
    await settle(() => pending.resolve(anchors('p2')));
    await settle(() => view.host.querySelector<HTMLButtonElement>('[data-move-anchor="occurrence-b"]')!.click());
    expect(view.choice()).toEqual({
      destination: { id: 'target', title: 'Target', revision: 7 },
      after: 'occurrence-b',
      anchor: { id: 'occurrence-b', title: 'Repeated subject', page: 1, position: 2 },
    });
    pending = deferred();
    await view.click(m.library_collection_move_more_members());
    await settle(() => pending.reject(new Error('offline')));
    expect(view.choice()).toBeNull();
    pending = deferred();
    header.mockResolvedValue({ id: 'target', title: 'New title', revision: 99 });
    await view.click(m.library_collection_move_retry());
    expect(pageRead.mock.calls.at(-1)![0]).toEqual({ data: { collectionId: 'target', revision: 7, cursor: 'p2' } });
    await settle(() => pending.resolve(anchors('p3')));
    expect(view.choice()).toBeNull();
    await settle(() => view.host.querySelector<HTMLButtonElement>('[data-move-anchor="occurrence-a"]')!.click());
    expect(view.choice()!.anchor).toEqual({ id: 'occurrence-a', title: 'Repeated subject', page: 2, position: 1 });
    pending = deferred();
    await view.click(m.library_collection_move_more_members());
    await settle(() => pending.reject(new Error('offline')));
    pending = deferred();
    await view.click(m.library_collection_move_retry());
    const replaced = pending;
    await settle(() => view.render('replacement'));
    pending = deferred();
    header.mockResolvedValue({ id: 'other', title: 'Other', revision: 11 });
    await settle(() => view.row('other').click());
    await settle(() => replaced.resolve(anchors()));
    expect(view.host.querySelector('[data-collection-move-chooser]')!.getAttribute('aria-busy')).toBe('true');
    await settle(() => pending.resolve(anchors('new-frontier')));
    expect(view.choice()!.destination.id).toBe('other');
    pending = deferred();
    await view.click(m.library_collection_move_more_members());
    await settle(() => pending.reject(new Error('offline')));
    pending = deferred();
    await view.click(m.library_collection_move_retry());
    view.retire();
    await settle(() => pending.reject(new Error('Move destination changed')));
    expect(view.host.textContent).not.toContain(m.library_collection_move_destination_changed());
    expect(view.choice()).toBeNull();
  } finally {
    await view.close();
  }
});
